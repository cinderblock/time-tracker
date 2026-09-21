import type { JobView } from "./model.ts";

/**
 * How the job picker arranges the list: the jobs used most recently first,
 * then each customer with its jobs — and a job's sub-jobs nested under it,
 * the way they nest in the accounting system. Pure, so the server could use
 * it too.
 */

/** What nesting needs of a row. The admin page's own shape qualifies too. */
export interface JobLike {
  id: string;
  name: string;
  /** "Customer:Job" path. */
  fullName: string;
  parentId: string | null;
}

/** A job with the sub-jobs under it. */
export interface JobNode<T extends JobLike = JobView> {
  job: T;
  children: JobNode<T>[];
}

/** A customer and its jobs as trees. A customer never takes time itself. */
export interface JobGroup<T extends JobLike = JobView> {
  customer: T;
  jobs: JobNode<T>[];
}

export interface JobGroups {
  /** Bookable jobs from the recent list, in its order. */
  recent: JobView[];
  /** Customers with at least one bookable job somewhere under them, by name. */
  customers: JobGroup[];
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/**
 * Customers with their jobs as trees: customers by name, siblings by their
 * own name. A row whose line of parents isn't all in the list is left out —
 * it has nowhere to sit.
 *
 * `keep` says which jobs are worth listing. One it rejects is still listed
 * when a job under it is kept: it's the path to that one, drawn as a heading
 * rather than a choice. A customer left with no jobs at all is dropped. With
 * no `keep`, every row is listed and every customer stays.
 */
export function jobTree<T extends JobLike>(jobs: readonly T[], keep?: (job: T) => boolean): JobGroup<T>[] {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const rooted = (job: T): boolean => {
    // `seen` guards against a cycle ever sneaking into the data.
    const seen = new Set([job.id]);
    for (let j = job; j.parentId != null; ) {
      const parent = byId.get(j.parentId);
      if (!parent || seen.has(parent.id)) return false;
      seen.add(parent.id);
      j = parent;
    }
    return true;
  };

  const customers: T[] = [];
  const children = new Map<string, T[]>();
  for (const job of jobs) {
    if (!rooted(job)) continue;
    if (job.parentId == null) customers.push(job);
    else {
      const siblings = children.get(job.parentId);
      if (siblings) siblings.push(job);
      else children.set(job.parentId, [job]);
    }
  }

  const under = (parent: T): JobNode<T>[] =>
    (children.get(parent.id) ?? [])
      .sort((a, b) => byName(a.name, b.name))
      .map((job) => ({ job, children: under(job) }))
      .filter((node) => keep == null || keep(node.job) || node.children.length > 0);

  return customers
    .sort((a, b) => byName(a.fullName, b.fullName))
    .map((customer) => ({ customer, jobs: under(customer) }))
    .filter((group) => keep == null || group.jobs.length > 0);
}

/** One customer's trees as rows to draw, each with how deep it sits. */
export function jobRows<T extends JobLike>(nodes: readonly JobNode<T>[], depth = 0): { job: T; depth: number }[] {
  return nodes.flatMap((node) => [{ job: node.job, depth }, ...jobRows(node.children, depth + 1)]);
}

export function groupJobs(jobs: readonly JobView[], recentIds: readonly string[]): JobGroups {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const recent = recentIds.map((id) => byId.get(id)).filter((j): j is JobView => j != null && j.bookable);
  return { recent, customers: jobTree(jobs, (job) => job.bookable) };
}

/**
 * A job's name within one of its parents: "Customer:Job:Sub" under
 * "Customer:Job" is "Sub". For anything else on screen, `src/job-names.ts`
 * says how a path is written — never with the ":" it is stored with.
 */
export function nameWithin(job: Pick<JobLike, "fullName">, parent: Pick<JobLike, "fullName">): string {
  const prefix = `${parent.fullName}:`;
  return job.fullName.startsWith(prefix) ? job.fullName.slice(prefix.length) : job.fullName;
}

/** The customers a new job could go under, by name. */
export function listCustomers(jobs: readonly JobView[]): JobView[] {
  return jobs.filter((j) => j.parentId == null).sort((a, b) => byName(a.fullName, b.fullName));
}
