import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { type APIRequestContext, expect, test } from "@playwright/test";
import { XMLParser } from "fast-xml-parser";

import { e2eEnv, qbwcEnv } from "../playwright.config.ts";
import { xmlText } from "../src/accounting/qbxml.ts";
import { sampleCompany } from "../src/testing/fake-quickbooks.ts";

/**
 * The Web Connector's endpoint over real HTTP: the SOAP conversation, the
 * support page, the admin's setup page and connection file, and that the
 * endpoint is closed when the Web Connector isn't the configured backend.
 */
test.describe.configure({ mode: "serial" });

const soap = new XMLParser({ removeNSPrefix: true, parseTagValue: false, htmlEntities: true, isArray: (n) => n === "string" });

async function call(request: APIRequestContext, method: string, params: Record<string, string>) {
  const body =
    '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body><${method} xmlns="http://developer.intuit.com/">` +
    Object.entries(params)
      .map(([k, v]) => `<${k}>${xmlText(v)}</${k}>`)
      .join("") +
    `</${method}></soap:Body></soap:Envelope>`;
  const response = await request.post("/qbwc", {
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"http://developer.intuit.com/${method}"` },
    data: body,
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/xml");
  const doc = soap.parse(await response.text()) as Record<string, any>;
  return doc.Envelope.Body[`${method}Response`][`${method}Result`];
}

test("a whole Web Connector session over HTTP", async ({ request }) => {
  expect(await (await request.get("/qbwc")).text()).toContain("QuickBooks Web Connector endpoint");

  const refused = await call(request, "authenticate", { strUserName: "e2e-qbwc", strPassword: "nope" });
  expect(refused.string).toEqual(["", "nvu"]);

  const [ticket, status] = (await call(request, "authenticate", { strUserName: "e2e-qbwc", strPassword: "e2e-qbwc-password" })).string;
  expect(status).toBe(""); // the first pull is due
  const qbxml = await call(request, "sendRequestXML", {
    ticket,
    strHCPResponse: "",
    strCompanyFileName: "C:\\Company.qbw",
    qbXMLCountry: "US",
    qbXMLMajorVers: "16",
    qbXMLMinorVers: "0",
  });
  expect(qbxml).toContain("<CustomerQueryRq");
  const answer = sampleCompany().handle(qbxml);
  expect(await call(request, "receiveResponseXML", { ticket, response: answer, hresult: "", message: "" })).toBe("100");
  expect(await call(request, "closeConnection", { ticket })).toBe("Done: 1 request.");

  // Nothing left to do now.
  expect((await call(request, "authenticate", { strUserName: "e2e-qbwc", strPassword: "e2e-qbwc-password" })).string[1]).toBe("none");
});

test("broken requests get a SOAP fault; the support page answers", async ({ request }) => {
  const fault = await request.post("/qbwc", { headers: { "Content-Type": "text/xml" }, data: "<nonsense" });
  expect(fault.status()).toBe(500);
  expect(await fault.text()).toContain("<faultstring>");
  const support = await request.get("/qbwc/support");
  expect(support.status()).toBe(200);
  expect(await support.text()).toContain("E2E Connector");
});

test("the connection file is for admins", async ({ request, browser }) => {
  const anonymous = await request.get("/admin/accounting.qwc", { maxRedirects: 0 });
  expect(anonymous.status()).toBe(302);
  expect(anonymous.headers().location).toContain("/signin");

  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const url = execFileSync("bun", ["src/cli/admin-link.ts"], {
    env: { ...process.env, ...qbwcEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .split(/\r?\n/)
    .pop()!;
  await page.goto(url);
  await page.getByLabel("Your name").fill("Connie Connector");
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page.getByRole("link", { name: "Accounting" }).click();
  await expect(page.getByText("QuickBooks, through the Web Connector")).toBeVisible();
  await expect(page.getByText(/Last heard from the Web Connector (just now|\d+ min ago): nothing to do\./)).toBeVisible();
  // The pull the session above made is here.
  await expect(page.getByText(/Lists last refreshed/)).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download the connection file" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("e2e-connector.qwc");
  const qwc = readFileSync((await file.path())!, "utf8");
  expect(qwc).toContain(`<AppURL>${qbwcEnv.PUBLIC_BASE_URL}/qbwc</AppURL>`);
  expect(qwc).toContain("<UserName>e2e-qbwc</UserName>");
  await context.close();
});

test("the endpoint is closed when the Web Connector isn't in use", async ({ playwright }) => {
  const standalone = await playwright.request.newContext({ baseURL: e2eEnv.PUBLIC_BASE_URL });
  expect((await standalone.post("/qbwc", { data: "<x/>" })).status()).toBe(404);
  expect((await standalone.get("/qbwc/support")).status()).toBe(404);
  await standalone.dispose();
});
