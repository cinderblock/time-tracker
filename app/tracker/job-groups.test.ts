import { describe, expect, test } from "bun:test";

import { type JobGroup, groupJobs, jobRows, jobTree, listCustomers, nameWithin, splitJobName } from "./job-groups.ts";
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
const deck = job("deck", "Acme:Install:Punch list:Deck", "punch");
const attic = job("attic", "Acme:Install:Attic", "install");
const service = job("service", "Acme:Service", "acme");
const zeta = job("zeta", "Zeta Ltd", null);
const zetaAudit = job("audit", "Zeta Ltd:Audit", "zeta");
const beta = job("beta", "beta co", null);
const betaOnly = job("beta-1", "beta co:Only", "beta");
const empty = job("empty", "Empty Customer", null);
const all = [zetaAudit, zeta, service, deck, punch, attic, install, acme, betaOnly, beta, empty];

/** A group as indented names, the way the picker draws it. */
const shape = (group: JobGroup) => jobRows(group.jobs).map(({ job, depth }) => `${"  ".repeat(depth)}${job.name}`);

describe("jobTree", () => {
  test("customers by name, siblings by name, sub-jobs under the job they belong to", () => {
    const tree = jobTree(all);
    expect(tree.map((g) => g.customer.fullName)).toEqual(["Acme", "beta co", "Empty Customer", "Zeta Ltd"]);
    expect(shape(tree[0]!)).toEqual(["Install", "  Attic", "  Punch list", "    Deck", "Service"]);
  });

  test("with no rule about what to keep, a customer with no jobs stays", () => {
    expect(jobTree(all).find((g) => g.customer.id === "empty")?.jobs).toEqual([]);
  });

  test("a job whose line of parents is broken isn't shown", () => {
    const orphan = job("orphan", "Gone:Orphan", "gone");
    const tree = jobTree([orphan, acme, install]);
    expect(tree.map((g) => g.customer.id)).toEqual(["acme"]);
    expect(shape(tree[0]!)).toEqual(["Install"]);
  });

  test("a cycle in the data drops the rows caught in it", () => {
    const hen = job("hen", "Hen", "egg");
    const egg = job("egg", "Egg", "hen");
    expect(jobTree([acme, install, hen, egg]).map((g) => g.customer.id)).toEqual(["acme"]);
  });

  test("`keep` drops a subtree with nothing worth listing, but keeps the way to one that is", () => {
    const phase = job("phase", "Acme:Phase", "acme", { bookable: false });
    const roof = job("roof", "Acme:Phase:Roof", "phase");
    const shut = job("shut", "Acme:Shut", "acme", { bookable: false });
    const shutSub = job("shut-sub", "Acme:Shut:Old", "shut", { bookable: false });
    const tree = jobTree([acme, phase, roof, shut, shutSub], (j) => j.bookable);
    // "Phase" itself can't take time; it stays because "Roof" under it can.
    expect(shape(tree[0]!)).toEqual(["Phase", "  Roof"]);
  });

  test("`keep` drops a customer left with no jobs", () => {
    expect(jobTree(all, (j) => j.bookable).map((g) => g.customer.id)).toEqual(["acme", "beta", "zeta"]);
  });
});

describe("groupJobs", () => {
  test("customers with their jobs as a tree; empty customers left out", () => {
    const groups = groupJobs(all, []);
    expect(groups.recent).toEqual([]);
    expect(groups.customers.map((g) => [g.customer.fullName, shape(g)])).toEqual([
      ["Acme", ["Install", "  Attic", "  Punch list", "    Deck", "Service"]],
      ["beta co", ["Only"]],
      ["Zeta Ltd", ["Audit"]],
    ]);
  });

  test("recents keep their order and skip what can't be booked", () => {
    const closed = job("closed", "Acme:Closed", "acme", { bookable: false });
    const groups = groupJobs([...all, closed], ["audit", "closed", "acme", "gone", "install"]);
    expect(groups.recent.map((j) => j.id)).toEqual(["audit", "install"]);
    // A job that isn't bookable and has no sub-jobs is listed under no customer either.
    expect(groups.customers.flatMap((g) => jobRows(g.jobs).map((r) => r.job.id))).not.toContain("closed");
  });
});

describe("names", () => {
  test("nameWithin drops the prefix of the row it's under", () => {
    expect(nameWithin(install, acme)).toBe("Install");
    expect(nameWithin(punch, acme)).toBe("Install:Punch list");
    expect(nameWithin(punch, install)).toBe("Punch list");
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
