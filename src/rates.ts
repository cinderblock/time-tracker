import { audit } from "./audit.ts";
import { getCategory } from "./categories.ts";
import { db } from "./db.server.ts";
import { getJob } from "./jobs.ts";
import { MAX_HOURLY_RATE } from "./limits.ts";
import { RATE_SCOPES, type RateScope } from "./rate-scopes.ts";
import { isWorkDate } from "./time.ts";
import { UserInputError, getUser } from "./users.ts";

/**
 * Hourly rates, and which one applies to a piece of work.
 *
 * A rate is set for a scope (rate-scopes.ts), and takes effect on a date.
 * The most specific scope that has a rate in effect on the work's date wins,
 * in the order RATE_SCOPES lists them. Job rates also cover the job's sub-jobs; the nearest
 * job up the tree wins within a scope. A person's category is their current
 * one.
 *
 * Rates are never edited in place: setting a rate for the same scope and date
 * replaces it (the old row is kept, marked deleted), and a raise is a new rate
 * with a later date, so work before the raise keeps its old rate. Approval
 * copies the rate onto the entry (approvals.ts), so nothing done here changes
 * approved time.
 */

export { RATE_SCOPES, type RateScope };

export interface Rate {
  id: number;
  scope: RateScope;
  userId: number | null;
  jobId: string | null;
  categoryId: number | null;
  hourlyRate: number;
  /** 'YYYY-MM-DD': applies to work on or after this date. */
  effectiveFrom: string;
  createdBy: number | null;
  createdAt: number;
}

interface RateRow {
  id: number;
  scope: RateScope;
  user_id: number | null;
  job_id: string | null;
  category_id: number | null;
  hourly_rate: number;
  effective_from: string;
  created_by: number | null;
  created_at: number;
}

const toRate = (r: RateRow): Rate => ({
  id: r.id,
  scope: r.scope,
  userId: r.user_id,
  jobId: r.job_id,
  categoryId: r.category_id,
  hourlyRate: r.hourly_rate,
  effectiveFrom: r.effective_from,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const COLUMNS = "id, scope, user_id, job_id, category_id, hourly_rate, effective_from, created_by, created_at";

/** Every rate in force or scheduled, oldest date first. */
export function listRates(): Rate[] {
  return db()
    .query<RateRow, []>(
      `SELECT ${COLUMNS} FROM rates WHERE deleted_at IS NULL ORDER BY effective_from, id`,
    )
    .all()
    .map(toRate);
}

export function getRate(id: number): Rate | null {
  const row = db()
    .query<RateRow, [number]>(`SELECT ${COLUMNS} FROM rates WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  return row ? toRate(row) : null;
}

/** Money to the cent, from a form field or a number. */
export function parseHourlyRate(raw: unknown): number {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().replace(/^\$/, "") : "";
  const value = Number(text.replace(/,/g, ""));
  if (text === "" || !Number.isFinite(value)) throw new UserInputError("Enter an hourly rate, like 45 or 45.50.");
  if (value < 0) throw new UserInputError("A rate can't be negative.");
  if (value > MAX_HOURLY_RATE) throw new UserInputError("That rate looks too high. Check for a typo.");
  return Math.round(value * 100) / 100;
}

interface Target {
  userId: number | null;
  jobId: string | null;
  categoryId: number | null;
}

function checkTarget(scope: RateScope, t: Partial<Target>): Target {
  const needs = {
    user: scope === "user" || scope === "user_job",
    job: scope === "job" || scope === "user_job",
    category: scope === "category",
  };
  const target: Target = {
    userId: needs.user ? (t.userId ?? null) : null,
    jobId: needs.job ? (t.jobId ?? null) : null,
    categoryId: needs.category ? (t.categoryId ?? null) : null,
  };
  if (needs.user && (target.userId == null || !getUser(target.userId))) throw new UserInputError("Pick a person.");
  if (needs.job && (target.jobId == null || !getJob(target.jobId))) throw new UserInputError("Pick a job.");
  if (needs.category && (target.categoryId == null || !getCategory(target.categoryId))) {
    throw new UserInputError("Pick a category.");
  }
  return target;
}

/**
 * Set a rate. A rate already set for the same scope and date is replaced.
 */
export function setRate(args: {
  scope: RateScope;
  userId?: number | null;
  jobId?: string | null;
  categoryId?: number | null;
  hourlyRate: number;
  effectiveFrom: string;
  actorUserId: number;
  now?: number;
}): Rate {
  if (!RATE_SCOPES.includes(args.scope)) throw new UserInputError("Pick who the rate applies to.");
  if (!isWorkDate(args.effectiveFrom)) throw new UserInputError("Pick the date the rate starts.");
  const hourlyRate = parseHourlyRate(args.hourlyRate);
  const target = checkTarget(args.scope, args);
  const now = args.now ?? Date.now();

  return db().transaction(() => {
    const replaced = db()
      .query<RateRow, [RateScope, number | null, string | null, number | null, string]>(
        `SELECT ${COLUMNS} FROM rates
          WHERE scope = ? AND user_id IS ? AND job_id IS ? AND category_id IS ?
            AND effective_from = ? AND deleted_at IS NULL`,
      )
      .get(args.scope, target.userId, target.jobId, target.categoryId, args.effectiveFrom);
    if (replaced) db().query("UPDATE rates SET deleted_at = ? WHERE id = ?").run(now, replaced.id);

    const { id } = db()
      .query<{ id: number }, [RateScope, number | null, string | null, number | null, number, string, number, number]>(
        `INSERT INTO rates (scope, user_id, job_id, category_id, hourly_rate, effective_from, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(args.scope, target.userId, target.jobId, target.categoryId, hourlyRate, args.effectiveFrom, args.actorUserId, now)!;
    audit({
      actorUserId: args.actorUserId,
      entity: "rate",
      entityId: id,
      action: "set",
      before: replaced ? { id: replaced.id, hourlyRate: replaced.hourly_rate } : undefined,
      after: { scope: args.scope, ...target, hourlyRate, effectiveFrom: args.effectiveFrom },
      at: now,
    });
    return getRate(id)!;
  })();
}

export function removeRate(args: { id: number; actorUserId: number; now?: number }): Rate {
  const rate = getRate(args.id);
  if (!rate) throw new UserInputError("That rate no longer exists.");
  const now = args.now ?? Date.now();
  db().query("UPDATE rates SET deleted_at = ? WHERE id = ?").run(now, rate.id);
  audit({ actorUserId: args.actorUserId, entity: "rate", entityId: rate.id, action: "remove", before: rate, at: now });
  return rate;
}

// ---- resolution -------------------------------------------------------------------

export interface ResolvedRate {
  hourlyRate: number;
  scope: RateScope;
  rateId: number;
}

export type RateResolver = (userId: number, jobId: string | null, workDate: string) => ResolvedRate | null;

/**
 * A resolver over a snapshot of the rates, people and jobs, for resolving
 * many entries at once (approving a week, a report) without a query each.
 */
export function rateResolver(): RateResolver {
  // Per target, newest date first, so the first date <= the work date wins.
  const byKey = new Map<string, Rate[]>();
  for (const r of listRates().reverse()) {
    const key = `${r.scope}|${r.userId ?? ""}|${r.jobId ?? ""}|${r.categoryId ?? ""}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  const find = (key: string, workDate: string) => byKey.get(key)?.find((r) => r.effectiveFrom <= workDate);

  const parents = new Map(
    db()
      .query<{ id: string; parent_id: string | null }, []>("SELECT id, parent_id FROM jobs")
      .all()
      .map((r) => [r.id, r.parent_id]),
  );
  const lineage = (jobId: string | null): string[] => {
    const chain: string[] = [];
    for (let id = jobId; id != null && !chain.includes(id); id = parents.get(id) ?? null) chain.push(id);
    return chain;
  };

  const categories = new Map(
    db()
      .query<{ id: number; category_id: number | null }, []>("SELECT id, category_id FROM users")
      .all()
      .map((r) => [r.id, r.category_id]),
  );

  const hit = (r: Rate | undefined): ResolvedRate | null =>
    r ? { hourlyRate: r.hourlyRate, scope: r.scope, rateId: r.id } : null;

  return (userId, jobId, workDate) => {
    const jobs = lineage(jobId);
    for (const j of jobs) {
      const r = find(`user_job|${userId}|${j}|`, workDate);
      if (r) return hit(r);
    }
    for (const j of jobs) {
      const r = find(`job||${j}|`, workDate);
      if (r) return hit(r);
    }
    const own = find(`user|${userId}||`, workDate);
    if (own) return hit(own);
    const category = categories.get(userId);
    if (category != null) {
      const r = find(`category|||${category}`, workDate);
      if (r) return hit(r);
    }
    return hit(find("global|||", workDate));
  };
}

/** The rate for one piece of work. For many, build a `rateResolver()` once. */
export function resolveRate(userId: number, jobId: string | null, workDate: string): ResolvedRate | null {
  return rateResolver()(userId, jobId, workDate);
}

/** Cost of some seconds at an hourly rate, to the cent. */
export function costOf(seconds: number, hourlyRate: number): number {
  return Math.round((seconds / 3600) * hourlyRate * 100) / 100;
}
