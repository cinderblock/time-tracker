import { data, redirect } from "react-router";

import { config } from "../../src/config.server.ts";
import { WORK_DATE_PATTERN, addDays, formatWorkDate, today } from "../../src/time.ts";
import { requireUser } from "../auth.server.ts";
import { loadDay } from "../tracker.server.ts";
import { loadDayWithFallback } from "../offline/loaders.ts";
import { TrackerScreen, TrackerSkeleton } from "../tracker/TrackerScreen.tsx";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.day.$date";

/** Any past day's tracking screen, for filling in or fixing time after the fact. */
export function loader({ request, context, params }: Route.LoaderArgs) {
  const { user } = requireUser(context, request);
  const date = params.date;
  // Round-tripping through addDays rejects impossible dates like 2026-02-30.
  if (!WORK_DATE_PATTERN.test(date) || addDays(date, 0) !== date) {
    throw data("That isn't a date.", { status: 404 });
  }
  const todayDate = today(config.timezone);
  if (date === todayDate) throw redirect("/");
  if (date > todayDate) throw data("That day hasn't happened yet.", { status: 404 });
  return loadDay(user.id, date);
}

export async function clientLoader({ serverLoader, params }: Route.ClientLoaderArgs) {
  return loadDayWithFallback(serverLoader, params.date);
}
clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return <TrackerSkeleton />;
}

export function meta({ loaderData, matches }: Route.MetaArgs) {
  return pageTitle(matches, loaderData ? formatWorkDate(loaderData.workDate, { withYear: true }) : "Day");
}

export default function Day({ loaderData }: Route.ComponentProps) {
  return <TrackerScreen model={loaderData} />;
}
