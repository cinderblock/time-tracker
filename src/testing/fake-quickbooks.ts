import { XMLParser } from "fast-xml-parser";

import { xmlText } from "../accounting/qbxml.ts";

/**
 * A pretend QuickBooks company file that answers qbXML — enough of it to
 * test sending time end to end through the real encoder and parser: lists,
 * time records with edit sequences, deletes, new customers, the SDK's status
 * codes, and the element order QuickBooks insists on.
 *
 * Failure injection: `failNext(code)` answers the next request with an error;
 * `loseNextAnswer()` applies the next request but makes the caller think the
 * connection dropped (the case that can cause duplicates).
 */

export interface FakeRecord {
  txnId: string;
  editSequence: string;
  txnDate: string;
  entity: string;
  customer: string | null;
  item: string | null;
  payrollItem: string | null;
  duration: string;
  notes: string;
  billable: string;
}

interface Named {
  id: string;
  name: string;
  active: boolean;
}

interface Customer extends Named {
  parent: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  htmlEntities: true,
  isArray: (name) => name === "IncludeRetElement",
});

type Node = Record<string, unknown>;
const str = (v: unknown) => (v == null ? "" : String(v));
const listId = (v: unknown) => ((v as Node | undefined)?.ListID == null ? null : str((v as Node).ListID));

/** The order QuickBooks requires inside TimeTrackingAdd (Mod adds TxnID and EditSequence first). */
const TIME_ORDER = [
  "TxnDate",
  "EntityRef",
  "CustomerRef",
  "ItemServiceRef",
  "Duration",
  "ClassRef",
  "PayrollItemWageRef",
  "Notes",
  "BillableStatus",
];

/** Top-level child element names of the first `<tag>…</tag>` in a document. */
function childOrder(xml: string, tag: string): string[] {
  const start = xml.indexOf(`<${tag}>`);
  const end = xml.indexOf(`</${tag}>`);
  if (start < 0 || end < 0) return [];
  const inner = xml.slice(start + tag.length + 2, end);
  const names: string[] = [];
  let depth = 0;
  for (const m of inner.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (closing) depth--;
    else {
      if (depth === 0) names.push(name!);
      if (!selfClosing) depth++;
    }
  }
  return names;
}

function inOrder(names: string[], order: string[]): boolean {
  let last = -1;
  for (const n of names) {
    const i = order.indexOf(n);
    if (i < last) return false;
    last = i;
  }
  return true;
}

export class FakeQuickBooks {
  customers: Customer[] = [];
  employees: Named[] = [];
  vendors: Named[] = [];
  others: Named[] = [];
  services: (Named & { fullName: string })[] = [];
  wages: Named[] = [];
  records: FakeRecord[] = [];
  /** Payroll switched off: wage queries fail. */
  payrollEnabled = true;
  requests: string[] = [];
  private seq = 1000;
  private failures: { code: number; message: string }[] = [];
  private loseAnswer = false;

  failNext(code: number, message = `Simulated error ${code}`): void {
    this.failures.push({ code, message });
  }

  loseNextAnswer(): void {
    this.loseAnswer = true;
  }

  private nextId(prefix: string): string {
    this.seq++;
    return `${prefix}${this.seq.toString(16).toUpperCase()}-1726500000`;
  }

  /** Change a record "in QuickBooks", as someone at the desk would. */
  touch(txnId: string): void {
    const r = this.records.find((x) => x.txnId === txnId);
    if (r) r.editSequence = String(Number(r.editSequence) + 1);
  }

  fullNameOf(id: string): string {
    const parts: string[] = [];
    for (let c = this.customers.find((x) => x.id === id); c; c = this.customers.find((x) => x.id === c!.parent)) {
      parts.unshift(c.name);
    }
    return parts.join(":");
  }

  /**
   * Answer a qbXML request. Throws `LostAnswer` after applying a request
   * whose answer was set to be lost.
   */
  handle(requestXml: string): string {
    this.requests.push(requestXml);
    const doc = parser.parse(requestXml) as Node;
    const rq = ((doc.QBXML as Node).QBXMLMsgsRq ?? {}) as Node;
    const out: string[] = [];
    for (const [name, value] of Object.entries(rq)) {
      if (name.startsWith("@_")) continue;
      for (const node of Array.isArray(value) ? value : [value]) {
        out.push(this.one(name, (node ?? {}) as Node, requestXml));
      }
    }
    const answer = `<?xml version="1.0" ?><QBXML><QBXMLMsgsRs>${out.join("")}</QBXMLMsgsRs></QBXML>`;
    if (this.loseAnswer) {
      this.loseAnswer = false;
      throw new LostAnswer();
    }
    return answer;
  }

  private one(name: string, node: Node, raw: string): string {
    const rsName = name.replace(/Rq$/, "Rs");
    const id = xmlText(str(node["@_requestID"]));
    const status = (code: number, message: string, body = "") =>
      `<${rsName} requestID="${id}" statusCode="${code}" statusSeverity="${code === 0 || code === 1 ? "Info" : "Error"}" statusMessage="${xmlText(message)}">${body}</${rsName}>`;
    const ok = (body: string) => status(0, "Status OK", body);

    const injected = this.failures.shift();
    if (injected) return status(injected.code, injected.message);

    const el = (tag: string, v: string | null) => (v == null ? "" : `<${tag}>${xmlText(v)}</${tag}>`);
    const refEl = (tag: string, v: string | null) => (v ? `<${tag}><ListID>${xmlText(v)}</ListID></${tag}>` : "");
    const named = (tag: string, list: Named[]) =>
      list.length
        ? ok(list.map((n) => `<${tag}>${el("ListID", n.id)}${el("Name", n.name)}${el("IsActive", String(n.active))}</${tag}>`).join(""))
        : status(1, "A query request did not find a matching object in QuickBooks");
    const timeRet = (r: FakeRecord) =>
      `<TimeTrackingRet>${el("TxnID", r.txnId)}${el("EditSequence", r.editSequence)}${el("TxnDate", r.txnDate)}` +
      `<EntityRef>${el("ListID", r.entity)}</EntityRef>${refEl("CustomerRef", r.customer)}${refEl("ItemServiceRef", r.item)}` +
      `${el("Duration", r.duration)}${refEl("PayrollItemWageRef", r.payrollItem)}${r.notes ? el("Notes", r.notes) : ""}` +
      `${el("BillableStatus", r.billable)}</TimeTrackingRet>`;
    const customerRet = (c: Customer) =>
      `<CustomerRet>${el("ListID", c.id)}${el("EditSequence", "1")}${el("Name", c.name)}${el("FullName", this.fullNameOf(c.id))}` +
      `${el("IsActive", String(c.active))}${c.parent ? `<ParentRef>${el("ListID", c.parent)}</ParentRef>` : ""}</CustomerRet>`;

    switch (name) {
      case "HostQueryRq":
        return ok("<HostRet><ProductName>QuickBooks Pretend Edition</ProductName></HostRet>");
      case "CompanyQueryRq":
        return ok("<CompanyRet><CompanyName>Pretend Company</CompanyName><LegalCompanyName>Pretend Company</LegalCompanyName></CompanyRet>");
      case "CustomerQueryRq":
        return this.customers.length ? ok(this.customers.map(customerRet).join("")) : status(1, "No match");
      case "EmployeeQueryRq":
        return named("EmployeeRet", this.employees);
      case "VendorQueryRq":
        return named("VendorRet", this.vendors);
      case "OtherNameQueryRq":
        return named("OtherNameRet", this.others);
      case "ItemServiceQueryRq":
        return this.services.length
          ? ok(
              this.services
                .map((s) => `<ItemServiceRet>${el("ListID", s.id)}${el("Name", s.name)}${el("FullName", s.fullName)}${el("IsActive", String(s.active))}</ItemServiceRet>`)
                .join(""),
            )
          : status(1, "No match");
      case "PayrollItemWageQueryRq":
        if (!this.payrollEnabled) return status(3250, "This feature is not enabled or not available in this version of QuickBooks.");
        return named("PayrollItemWageRet", this.wages);

      case "TimeTrackingAddRq":
      case "TimeTrackingModRq": {
        const isMod = name === "TimeTrackingModRq";
        const tag = isMod ? "TimeTrackingMod" : "TimeTrackingAdd";
        const fields = node[tag] as Node;
        const order = childOrder(raw, tag);
        if (!inOrder(order, isMod ? ["TxnID", "EditSequence", ...TIME_ORDER] : TIME_ORDER)) {
          return status(-1, `QuickBooks found an error when parsing the provided XML text stream (order: ${order.join(",")}).`);
        }
        const entity = listId(fields.EntityRef);
        if (!entity || ![...this.employees, ...this.vendors, ...this.others].some((p) => p.id === entity)) {
          return status(3140, `There is an invalid reference to QuickBooks Entity "${entity}" in the TimeTracking.`);
        }
        const customer = listId(fields.CustomerRef);
        if (customer && !this.customers.some((c) => c.id === customer)) {
          return status(3140, `There is an invalid reference to QuickBooks Customer "${customer}" in the TimeTracking.`);
        }
        const payrollItem = listId(fields.PayrollItemWageRef);
        if (payrollItem && !this.employees.some((e) => e.id === entity)) {
          return status(3180, "A payroll item can only be used with an employee.");
        }
        const values = {
          txnDate: str(fields.TxnDate),
          entity,
          customer,
          item: listId(fields.ItemServiceRef),
          payrollItem,
          duration: str(fields.Duration),
          notes: str(fields.Notes),
          billable: str(fields.BillableStatus),
        };
        if (!isMod) {
          const record: FakeRecord = { txnId: this.nextId("T"), editSequence: "1", ...values };
          this.records.push(record);
          return ok(timeRet(record));
        }
        const record = this.records.find((r) => r.txnId === str(fields.TxnID));
        if (!record) return status(3120, `Object "${str(fields.TxnID)}" specified in the request cannot be found.`);
        if (record.editSequence !== str(fields.EditSequence)) {
          return status(3200, "The provided edit sequence is out-of-date.");
        }
        Object.assign(record, values, { editSequence: String(Number(record.editSequence) + 1) });
        return ok(timeRet(record));
      }

      case "TimeTrackingQueryRq": {
        let found = this.records;
        if (node.TxnID != null) found = found.filter((r) => r.txnId === str(node.TxnID));
        const range = node.TxnDateRangeFilter as Node | undefined;
        if (range) found = found.filter((r) => r.txnDate >= str(range.FromTxnDate) && r.txnDate <= str(range.ToTxnDate));
        const who = node.TimeTrackingEntityFilter as Node | undefined;
        if (who) found = found.filter((r) => r.entity === str(who.ListID));
        return found.length ? ok(found.map(timeRet).join("")) : status(1, "No match");
      }

      case "TxnDelRq": {
        if (str(node.TxnDelType) !== "TimeTracking") return status(3000, "Only time can be deleted here.");
        const i = this.records.findIndex((r) => r.txnId === str(node.TxnID));
        if (i < 0) return status(3120, `Object "${str(node.TxnID)}" specified in the request cannot be found.`);
        this.records.splice(i, 1);
        return ok(`<TxnDelType>TimeTracking</TxnDelType>${el("TxnID", str(node.TxnID))}`);
      }

      case "CustomerAddRq": {
        const add = node.CustomerAdd as Node;
        const nameValue = str(add.Name);
        const parent = listId(add.ParentRef);
        if (nameValue.length > 41) return status(3070, "The string in the field Name is too long.");
        if (this.customers.some((c) => c.parent === parent && c.name.toLowerCase() === nameValue.toLowerCase())) {
          return status(3100, `The name "${nameValue}" of the list element is already in use.`);
        }
        const customer: Customer = { id: this.nextId("C"), name: nameValue, parent, active: true };
        this.customers.push(customer);
        return ok(customerRet(customer));
      }

      default:
        return status(3000, `Unsupported request ${name}`);
    }
  }

  /** Record fields in the shape tests compare against. */
  summary() {
    return this.records.map((r) => ({
      date: r.txnDate,
      entity: r.entity,
      customer: r.customer,
      item: r.item,
      payrollItem: r.payrollItem,
      duration: r.duration,
      notes: r.notes,
      billable: r.billable,
    }));
  }
}

export class LostAnswer extends Error {
  constructor() {
    super("The connection dropped after the request was sent.");
  }
}

/** A standard little company: two customers (one with a job), people of each kind, items. */
export function sampleCompany(): FakeQuickBooks {
  const qb = new FakeQuickBooks();
  qb.customers = [
    { id: "C-ACME", name: "Acme", parent: null, active: true },
    { id: "C-ACME-2", name: "Phase 2", parent: "C-ACME", active: true },
    { id: "C-OLD", name: "Old Client", parent: null, active: false },
  ];
  qb.employees = [{ id: "E-ALICE", name: "Alice A", active: true }];
  qb.vendors = [{ id: "V-SUB", name: "Sub Contracting LLC", active: true }];
  qb.others = [{ id: "O-GONE", name: "Former Helper", active: false }];
  qb.services = [
    { id: "I-LABOR", name: "Labor", fullName: "Labor", active: true },
    { id: "I-DESIGN", name: "Design", fullName: "Labor:Design", active: true },
  ];
  qb.wages = [{ id: "W-HOURLY", name: "Hourly", active: true }];
  return qb;
}

