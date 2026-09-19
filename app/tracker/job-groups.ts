import type { JobView } from "./model.ts";

/**
 * How the job picker arranges the list: the jobs used most recently first,
 * then each customer with its jobs. Pure, so the server could use it too.
 */

export interface JobGroups {
  /** Bookable jobs from the recent list, in its order. */
  recent: JobView[];
  /** Customers with at least one bookable job, by name; jobs by full name. */
  customers: { customer: JobView; jobs: JobView[] }[];
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

export function groupJobs(jobs: readonly JobView[], recentIds: readonly string[]): JobGroups {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const customerOf = (job: JobView): JobView | undefined => {
    let top = job;
    const seen = new Set<string>();
    while (top.parentId && !seen.has(top.id)) {
      seen.add(top.id);
      const parent = byId.get(top.parentId);
      if (!parent) return undefined;
      top = parent;
    }
    return top;
  };

  const groups = new Map<string, { customer: JobView; jobs: JobView[] }>();
  for (const job of jobs) {
    if (!job.bookable) continue;
    const customer = customerOf(job);
    if (!customer || customer.id === job.id) continue;
    let group = groups.get(customer.id);
    if (!group) groups.set(customer.id, (group = { customer, jobs: [] }));
    group.jobs.push(job);
  }
  const customers = [...groups.values()].sort((a, b) => byName(a.customer.fullName, b.customer.fullName));
  for (const group of customers) group.jobs.sort((a, b) => byName(a.fullName, b.fullName));

  const recent = recentIds.map((id) => byId.get(id)).filter((j): j is JobView => j != null && j.bookable);
  return { recent, customers };
}

/** A job's name within its customer: "Customer:Job:Sub" under "Customer" is "Job:Sub". */
export function nameWithin(job: Pick<JobView, "fullName">, customer: Pick<JobView, "fullName">): string {
  const prefix = `${customer.fullName}:`;
  return job.fullName.startsWith(prefix) ? job.fullName.slice(prefix.length) : job.fullName;
}

/** A "Customer:Job" path as its customer and the rest. A bare name has no customer. */
export function splitJobName(fullName: string): { customer: string | null; job: string } {
  const colon = fullName.indexOf(":");
  return colon < 0 ? { customer: null, job: fullName } : { customer: fullName.slice(0, colon), job: fullName.slice(colon + 1) };
}

/** The customers a new job could go under, by name. */
export function listCustomers(jobs: readonly JobView[]): JobView[] {
  return jobs.filter((j) => j.parentId == null).sort((a, b) => byName(a.fullName, b.fullName));
}
