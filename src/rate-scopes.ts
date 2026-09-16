/**
 * Who a rate applies to, most specific first. Shared with the browser (the
 * rates page), so this module must stay dependency-free; rates.ts has the rest.
 *
 *   user_job   one person on one job
 *   job        anyone on a job
 *   user       one person, on any job
 *   category   anyone in a category
 *   global     everyone — the organisation's default
 */
export type RateScope = "user_job" | "job" | "user" | "category" | "global";

export const RATE_SCOPES: readonly RateScope[] = ["user_job", "job", "user", "category", "global"];
