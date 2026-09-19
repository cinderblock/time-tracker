import { describe, expect, test } from "bun:test";

import { groupJobs, listCustomers, nameWithin, splitJobName } from "./job-groups.ts";
import type { JobView } from "./model.ts";

const job = (id: string, fullName: string, parentId: string | null, extra: Partial<JobView> = {}): JobView => ({
  id,
  name: fullName.split(":").at(-1)!,
  fullName,
  parentId,
  requiresNote: false,
  bookable: parentId != null,
  provisional: false,
  ...extra,
});

const acme = job("acme", "Acme", null);
const install = job("install", "Acme:Install", "acme");
const punch = job("punch", "Acme:Install:Punch list", "install");
const service = job("service", "Acme:Service", "acme");
const zeta = job("zeta", "Zeta Ltd", null);
const zetaAudit = job("audit", "Zeta Ltd:Audit", "zeta");
const beta = job("beta", "beta co", null);
const betaOnly = job("beta-1", "beta co:Only", "beta");
const empty = job("empty", "Empty Customer", null);
const all = [zetaAudit, zeta, service, punch, install, acme, betaOnly, beta, empty];

describe("groupJobs", () => {
  test("customers by name, their bookable jobs by full name; empty customers left out", () => {
    const groups = groupJobs(all, []);
    expect(groups.recent).toEqual([]);
    expect(groups.customers.map((g) => [g.customer.fullName, g.jobs.map((j) => j.fullName)])).toEqual([
      ["Acme", ["Acme:Install", "Acme:Install:Punch list", "Acme:Service"]],
      ["beta co", ["beta co:Only"]],
      ["Zeta Ltd", ["Zeta Ltd:Audit"]],
    ]);
  });

  test("recents keep their order and skip what can't be booked", () => {
    const closed = job("closed", "Acme:Closed", "acme", { bookable: false });
    const groups = groupJobs([...all, closed], ["audit", "closed", "acme", "gone", "install"]);
    expect(groups.recent.map((j) => j.id)).toEqual(["audit", "install"]);
    // A job that isn't bookable is listed under no customer either.
    expect(groups.customers.flatMap((g) => g.jobs.map((j) => j.id))).not.toContain("closed");
  });

  test("a job whose customer isn't in the list isn't shown", () => {
    const orphan = job("orphan", "Gone:Orphan", "gone");
    expect(groupJobs([orphan, acme, install], []).customers.map((g) => g.jobs.map((j) => j.id))).toEqual([["install"]]);
  });
});

describe("names", () => {
  test("nameWithin drops the customer's prefix only", () => {
    expect(nameWithin(install, acme)).toBe("Install");
    expect(nameWithin(punch, acme)).toBe("Install:Punch list");
    expect(nameWithin(zetaAudit, acme)).toBe("Zeta Ltd:Audit");
  });

  test("splitJobName separates the customer from the rest", () => {
    expect(splitJobName("Acme:Install:Punch list")).toEqual({ customer: "Acme", job: "Install:Punch list" });
    expect(splitJobName("Acme")).toEqual({ customer: null, job: "Acme" });
    expect(splitJobName("No job")).toEqual({ customer: null, job: "No job" });
  });

  test("listCustomers is the top-level rows by name", () => {
    expect(listCustomers(all).map((c) => c.fullName)).toEqual(["Acme", "beta co", "Empty Customer", "Zeta Ltd"]);
  });
});
