import { describe, expect, test } from "bun:test";

import { buildRequest, parseQbDuration, parseResponse, qbDuration, xmlText } from "./qbxml.ts";
import type { TimeRecord } from "./types.ts";

const record: TimeRecord = {
  txnDate: "2026-09-16",
  personRemoteId: "80000001-1",
  jobRemoteId: "80000010-1",
  serviceItemRemoteId: "80000020-1",
  payrollItemRemoteId: null,
  minutes: 95,
  notes: 'Café & "crane" <day 2> [ref 0123456789ab]',
  billable: true,
};

const wrap = (inner: string) =>
  `<?xml version="1.0" ?><QBXML><QBXMLMsgsRs>${inner}</QBXMLMsgsRs></QBXML>`;

describe("building requests", () => {
  test("a time record, with fields in the order QuickBooks requires", () => {
    const xml = buildRequest({ type: "time.add", record }, "e1");
    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8"?><?qbxml version="13.0"?>' +
        '<QBXML><QBXMLMsgsRq onError="stopOnError"><TimeTrackingAddRq requestID="e1"><TimeTrackingAdd>' +
        "<TxnDate>2026-09-16</TxnDate>" +
        "<EntityRef><ListID>80000001-1</ListID></EntityRef>" +
        "<CustomerRef><ListID>80000010-1</ListID></CustomerRef>" +
        "<ItemServiceRef><ListID>80000020-1</ListID></ItemServiceRef>" +
        "<Duration>PT1H35M0S</Duration>" +
        "<Notes>Caf&#233; &amp; &quot;crane&quot; &lt;day 2&gt; [ref 0123456789ab]</Notes>" +
        "<BillableStatus>Billable</BillableStatus>" +
        "</TimeTrackingAdd></TimeTrackingAddRq></QBXMLMsgsRq></QBXML>",
    );
  });

  test("a mod carries the id and version first; optional refs are left out", () => {
    const xml = buildRequest(
      {
        type: "time.mod",
        txnId: "1A-1",
        editSequence: "1726500000",
        record: { ...record, jobRemoteId: null, serviceItemRemoteId: null, payrollItemRemoteId: "P1", billable: false, notes: "" },
      },
      "e2",
    );
    expect(xml).toContain(
      "<TimeTrackingMod><TxnID>1A-1</TxnID><EditSequence>1726500000</EditSequence><TxnDate>2026-09-16</TxnDate>" +
        "<EntityRef><ListID>80000001-1</ListID></EntityRef><Duration>PT1H35M0S</Duration>" +
        "<PayrollItemWageRef><ListID>P1</ListID></PayrollItemWageRef><BillableStatus>NotBillable</BillableStatus></TimeTrackingMod>",
    );
  });

  test("finding, deleting, adding a job, pulling and pinging", () => {
    expect(buildRequest({ type: "time.find", by: { txnDate: "2026-09-16", personRemoteId: "E1" } }, "f")).toContain(
      '<TimeTrackingQueryRq requestID="f"><TxnDateRangeFilter><FromTxnDate>2026-09-16</FromTxnDate><ToTxnDate>2026-09-16</ToTxnDate></TxnDateRangeFilter><TimeTrackingEntityFilter><ListID>E1</ListID></TimeTrackingEntityFilter></TimeTrackingQueryRq>',
    );
    expect(buildRequest({ type: "time.find", by: { txnId: "T1" } }, "g")).toContain(
      '<TimeTrackingQueryRq requestID="g"><TxnID>T1</TxnID></TimeTrackingQueryRq>',
    );
    expect(buildRequest({ type: "time.delete", txnId: "T1" }, "d")).toContain(
      '<TxnDelRq requestID="d"><TxnDelType>TimeTracking</TxnDelType><TxnID>T1</TxnID></TxnDelRq>',
    );
    expect(buildRequest({ type: "job.add", name: "Phase 2", parentRemoteId: "C1" }, "j")).toContain(
      '<CustomerAdd><Name>Phase 2</Name><ParentRef><ListID>C1</ListID></ParentRef></CustomerAdd>',
    );
    const pull = buildRequest({ type: "pull" }, "p");
    expect(pull).toContain('onError="continueOnError"');
    for (const rq of ["Customer", "Employee", "Vendor", "OtherName", "ItemService", "PayrollItemWage"]) {
      expect(pull).toContain(`<${rq}QueryRq requestID="p-`);
    }
    expect(pull).toContain("<ActiveStatus>All</ActiveStatus><IncludeRetElement>ListID</IncludeRetElement>");
    expect(buildRequest({ type: "ping" }, "h")).toContain('<HostQueryRq requestID="h"/>');
  });

  test("text escaping drops what XML can't hold", () => {
    const [soh, tab, lf, cr, nel] = [1, 9, 10, 13, 0x85].map((c) => String.fromCharCode(c));
    expect(xmlText(`a${soh}b${tab}c${lf}d${cr}e${nel}f€😀`)).toBe(`ab${tab}c${lf}d&#13;ef&#8364;&#128512;`);
    expect(xmlText("'")).toBe("&apos;");
  });

  test("durations", () => {
    expect(qbDuration(0)).toBe("PT0H0M0S");
    expect(qbDuration(600.4)).toBe("PT10H0M0S");
    expect(parseQbDuration("PT1H35M0S")).toBe(95);
    expect(parseQbDuration("PT90M")).toBe(90);
    expect(parseQbDuration("PT1.5H")).toBe(90);
    expect(parseQbDuration("PT0H0M59S")).toBe(1);
    expect(parseQbDuration("nonsense")).toBe(0);
  });
});

describe("parsing responses", () => {
  test("a saved record", () => {
    const xml = wrap(
      `<TimeTrackingAddRs requestID="e1" statusCode="0" statusSeverity="Info" statusMessage="Status OK">
        <TimeTrackingRet><TxnID>1F-1726500000</TxnID><EditSequence>1726500000</EditSequence>
          <TxnDate>2026-09-16</TxnDate><Duration>PT1H35M0S</Duration></TimeTrackingRet>
      </TimeTrackingAddRs>`,
    );
    expect(parseResponse({ type: "time.add", record }, xml)).toEqual({
      ok: true,
      type: "time.saved",
      txnId: "1F-1726500000",
      editSequence: "1726500000",
    });
  });

  test("failures are classified", () => {
    const rs = (code: number, message: string) =>
      wrap(`<TimeTrackingModRs requestID="e" statusCode="${code}" statusSeverity="Error" statusMessage="${message}"/>`);
    const mod = { type: "time.mod", txnId: "T", editSequence: "1", record } as const;
    expect(parseResponse(mod, rs(3200, "The provided edit sequence is out-of-date."))).toMatchObject({
      ok: false,
      code: 3200,
      stale: true,
      retryable: false,
    });
    expect(parseResponse(mod, rs(3120, "Object not found."))).toMatchObject({ missing: true });
    expect(parseResponse(mod, rs(3175, "In use."))).toMatchObject({ retryable: true });
    expect(parseResponse(mod, rs(3100, "The name is already in use."))).toMatchObject({ duplicate: true });
    expect(parseResponse(mod, rs(3140, "Invalid reference to Customer."))).toMatchObject({
      ok: false,
      code: 3140,
      message: "Invalid reference to Customer.",
      retryable: false,
    });
    expect(parseResponse(mod, "not xml <<<")).toMatchObject({ ok: false, code: -1, retryable: true });
    expect(parseResponse(mod, "<QBXML/>")).toMatchObject({ ok: false, code: -1 });
  });

  test("finding: nothing matched is an empty answer, not an error", () => {
    const find = { type: "time.find", by: { txnId: "x" } } as const;
    expect(
      parseResponse(find, wrap(`<TimeTrackingQueryRs requestID="f" statusCode="1" statusSeverity="Info" statusMessage="No match"/>`)),
    ).toEqual({ ok: true, type: "time.found", records: [] });
    const two = wrap(`<TimeTrackingQueryRs requestID="f" statusCode="0" statusSeverity="Info">
      <TimeTrackingRet><TxnID>A</TxnID><EditSequence>1</EditSequence><Duration>PT2H0M0S</Duration><Notes>Framing [ref 111111111111]</Notes></TimeTrackingRet>
      <TimeTrackingRet><TxnID>B</TxnID><EditSequence>2</EditSequence><Duration>PT0H30M0S</Duration></TimeTrackingRet>
    </TimeTrackingQueryRs>`);
    expect(parseResponse(find, two)).toEqual({
      ok: true,
      type: "time.found",
      records: [
        { txnId: "A", editSequence: "1", minutes: 120, notes: "Framing [ref 111111111111]" },
        { txnId: "B", editSequence: "2", minutes: 30, notes: "" },
      ],
    });
  });

  test("a pull reads every list, and survives payroll being switched off", () => {
    const xml = wrap(`
      <CustomerQueryRs requestID="p-customers" statusCode="0" statusSeverity="Info">
        <CustomerRet><ListID>C1</ListID><Name>Acme &amp; Sons</Name><FullName>Acme &amp; Sons</FullName><IsActive>true</IsActive></CustomerRet>
        <CustomerRet><ListID>C2</ListID><Name>Phase 2</Name><FullName>Acme &amp; Sons:Phase 2</FullName><IsActive>false</IsActive><ParentRef><ListID>C1</ListID><FullName>Acme &amp; Sons</FullName></ParentRef></CustomerRet>
      </CustomerQueryRs>
      <EmployeeQueryRs requestID="p-employees" statusCode="0" statusSeverity="Info">
        <EmployeeRet><ListID>E1</ListID><Name>Jos&#233; Diaz</Name><IsActive>true</IsActive></EmployeeRet>
      </EmployeeQueryRs>
      <VendorQueryRs requestID="p-vendors" statusCode="1" statusSeverity="Info" statusMessage="No match"/>
      <OtherNameQueryRs requestID="p-others" statusCode="0" statusSeverity="Info">
        <OtherNameRet><ListID>O1</ListID><Name>Temp</Name><IsActive>true</IsActive></OtherNameRet>
      </OtherNameQueryRs>
      <ItemServiceQueryRs requestID="p-services" statusCode="0" statusSeverity="Info">
        <ItemServiceRet><ListID>I1</ListID><Name>Labor</Name><FullName>Labor</FullName><IsActive>true</IsActive></ItemServiceRet>
      </ItemServiceQueryRs>
      <PayrollItemWageQueryRs requestID="p-wages" statusCode="3250" statusSeverity="Error" statusMessage="This feature is not enabled."/>
    `);
    expect(parseResponse({ type: "pull" }, xml)).toEqual({
      ok: true,
      type: "pull",
      lists: {
        jobs: [
          { remoteId: "C1", name: "Acme & Sons", fullName: "Acme & Sons", parentRemoteId: null, active: true },
          { remoteId: "C2", name: "Phase 2", fullName: "Acme & Sons:Phase 2", parentRemoteId: "C1", active: false },
        ],
        people: [
          { remoteId: "E1", name: "José Diaz", kind: "employee", active: true },
          { remoteId: "O1", name: "Temp", kind: "other", active: true },
        ],
        items: [{ remoteId: "I1", kind: "service", name: "Labor", fullName: "Labor", active: true }],
        skipped: ["wages"],
      },
    });

    // Losing the customer list, though, fails the pull.
    const broken = xml.replace('requestID="p-customers" statusCode="0"', 'requestID="p-customers" statusCode="3000"').replace(
      'statusCode="3000" statusSeverity="Info"',
      'statusCode="3000" statusSeverity="Error"',
    );
    expect(parseResponse({ type: "pull" }, broken)).toMatchObject({ ok: false, code: 3000 });
  });

  test("a new job and a ping", () => {
    expect(
      parseResponse(
        { type: "job.add", name: "Phase 3", parentRemoteId: "C1" },
        wrap(`<CustomerAddRs requestID="j" statusCode="0" statusSeverity="Info"><CustomerRet><ListID>C3</ListID><EditSequence>9</EditSequence><Name>Phase 3</Name><FullName>Acme:Phase 3</FullName><IsActive>true</IsActive><ParentRef><ListID>C1</ListID></ParentRef></CustomerRet></CustomerAddRs>`),
      ),
    ).toEqual({
      ok: true,
      type: "job.added",
      job: { remoteId: "C3", name: "Phase 3", fullName: "Acme:Phase 3", parentRemoteId: "C1", active: true },
    });
    expect(
      parseResponse(
        { type: "ping" },
        wrap(`<HostQueryRs requestID="h" statusCode="0" statusSeverity="Info"><HostRet><ProductName>QuickBooks Enterprise Solutions 24.0</ProductName></HostRet></HostQueryRs>`),
      ),
    ).toEqual({ ok: true, type: "pong", product: "QuickBooks Enterprise Solutions 24.0" });
  });
});
