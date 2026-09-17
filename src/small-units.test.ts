import { beforeEach, describe, expect, test } from "bun:test";

import { ensureBootstrapLink } from "./bootstrap.ts";
import { publicOrigin } from "./config.server.ts";
import { formatRelative } from "./format.ts";
import { findUsableRegistration } from "./registrations.ts";
import { safeRedirectPath } from "./safe-redirect.ts";
import { freshDb } from "./testing/db.ts";
import { describeUserAgent } from "./user-agent.ts";
import { createUser } from "./users.ts";
import { CEREMONY_TTL_MS, putCeremony, takeCeremony } from "./webauthn.ts";

describe("formatRelative", () => {
  const now = Date.parse("2026-09-16T20:00:00Z");
  test("says which way, even within a minute", () => {
    expect(formatRelative(now - 10_000, now)).toBe("just now");
    expect(formatRelative(now + 59_000, now)).toBe("in under a minute");
    expect(formatRelative(now + 90_000, now)).toBe("in 2 minutes");
    expect(formatRelative(now - 3 * 3600_000, now)).toBe("3 hours ago");
    expect(formatRelative(now - 24 * 3600_000, now)).toBe("yesterday");
  });
});

describe("publicOrigin", () => {
  test("takes an origin as browsers write it", () => {
    for (const ok of ["https://time.example.com", "http://localhost:3000", "https://10.0.0.5:8443"]) {
      expect(publicOrigin(ok)).toBe(ok);
    }
  });

  test("refuses anything passkeys would trip over", () => {
    for (const bad of [
      "https://time.example.com/",
      "https://time.example.com/app",
      "https://Time.example.com",
      "https://time.example.com:443",
      "time.example.com",
      "ftp://time.example.com",
      "",
    ]) {
      expect(() => publicOrigin(bad)).toThrow("PUBLIC_BASE_URL must be just the origin");
    }
  });
});

describe("configuration at startup", () => {
  /** Load the config module in a fresh process with these settings. */
  const load = (env: Record<string, string>) => {
    const base: Record<string, string | undefined> = { ...process.env, PUBLIC_BASE_URL: "http://localhost:3000", SESSION_SECRET: "x" };
    for (const key of ["ACCOUNTING_BACKEND", "QB_BRIDGE_URL", "QB_BRIDGE_API_KEY", "QBWC_PASSWORD"]) delete base[key];
    const run = Bun.spawnSync([process.execPath, "-e", "await import('./src/config.server.ts')"], {
      cwd: `${import.meta.dir}/..`,
      env: { ...base, ...env },
    });
    return { code: run.exitCode, stderr: run.stderr.toString() };
  };

  test("a QuickBooks backend without its credentials stops the app", () => {
    const bridge = load({ ACCOUNTING_BACKEND: "qb-bridge", QB_BRIDGE_URL: "http://10.0.0.1:8743" });
    expect(bridge.code).not.toBe(0);
    expect(bridge.stderr).toContain("ACCOUNTING_BACKEND=qb-bridge needs QB_BRIDGE_URL and QB_BRIDGE_API_KEY.");
    const qbwc = load({ ACCOUNTING_BACKEND: "qb-webconnector" });
    expect(qbwc.stderr).toContain("ACCOUNTING_BACKEND=qb-webconnector needs QBWC_PASSWORD.");

    expect(load({ ACCOUNTING_BACKEND: "qb-bridge", QB_BRIDGE_URL: "http://10.0.0.1:8743", QB_BRIDGE_API_KEY: "k" }).code).toBe(0);
    expect(load({}).code).toBe(0);
  });

  test("so does a public address with a path", () => {
    const run = load({ PUBLIC_BASE_URL: "https://time.example.com/" });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("PUBLIC_BASE_URL must be just the origin");
  });
});

describe("ensureBootstrapLink", () => {
  beforeEach(freshDb);

  const tokenOf = (url: string) => url.split("/join/")[1]!;
  const quiet = () => {};

  test("prints a working link while no admin exists", () => {
    const lines: string[] = [];
    const url = ensureBootstrapLink((l) => lines.push(l));
    expect(url).toStartWith("http://localhost:3000/join/");
    expect(lines.join("\n")).toContain(url!);
    expect(findUsableRegistration(tokenOf(url!))?.purpose).toBe("bootstrap");
  });

  test("each start replaces the previous link, so the latest log is always valid", () => {
    const first = ensureBootstrapLink(quiet)!;
    const second = ensureBootstrapLink(quiet)!;
    expect(findUsableRegistration(tokenOf(first))).toBeNull();
    expect(findUsableRegistration(tokenOf(second))).not.toBeNull();
  });

  test("does nothing once an admin exists", () => {
    createUser({ name: "Admin", role: "admin", actorUserId: null });
    const lines: string[] = [];
    expect(ensureBootstrapLink((l) => lines.push(l))).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe("ceremony store", () => {
  const T0 = Date.parse("2026-09-16T12:00:00Z");

  test("is single-use", () => {
    const id = putCeremony({ kind: "authenticate", challenge: "c1" }, T0);
    expect(takeCeremony(id, T0)?.challenge).toBe("c1");
    expect(takeCeremony(id, T0)).toBeNull();
  });

  test("expires", () => {
    const id = putCeremony({ kind: "authenticate", challenge: "c2" }, T0);
    expect(takeCeremony(id, T0 + CEREMONY_TTL_MS)).toBeNull();
  });

  test("ignores missing ids", () => {
    expect(takeCeremony(null)).toBeNull();
    expect(takeCeremony("unknown")).toBeNull();
  });
});

describe("safeRedirectPath", () => {
  test.each([
    ["/", "/"],
    ["/admin/people", "/admin/people"],
    ["/account?tab=passkeys#x", "/account?tab=passkeys#x"],
  ])("accepts same-origin path %p", (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });

  test.each([
    null,
    undefined,
    "",
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    `/foo${String.fromCharCode(0)}bar`,
    "/foo\nbar",
    "/signin",
    "/signin?next=/x",
    "/join/abc",
    "/signout",
  ])("rejects %p", (input) => {
    expect(safeRedirectPath(input, "/home")).toBe("/home");
  });

  test("does not reject paths that merely start with an auth word", () => {
    expect(safeRedirectPath("/signing-sheets")).toBe("/signing-sheets");
    expect(safeRedirectPath("/joinery")).toBe("/joinery");
  });
});

describe("describeUserAgent", () => {
  test.each([
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "iPhone · Safari",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1",
      "iPhone · Chrome",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
      "Android phone · Chrome",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0",
      "Windows PC · Edge",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      "Mac · Safari",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Linux PC · Firefox"],
    ["curl/8.0", "This device"],
    [null, "This device"],
  ])("%p → %p", (ua, expected) => {
    expect(describeUserAgent(ua)).toBe(expected);
  });
});
