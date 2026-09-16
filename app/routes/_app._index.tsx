import { config } from "../../src/config.server.ts";
import { today } from "../../src/time.ts";
import { requireUser } from "../auth.server.ts";
import { loadDay } from "../tracker.server.ts";
import { loadDayWithFallback } from "../offline/loaders.ts";
import { TrackerScreen, TrackerSkeleton } from "../tracker/TrackerScreen.tsx";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app._index";

/** Home: today's tracking screen. */
export function loader({ request, context }: Route.LoaderArgs) {
  const { user } = requireUser(context, request);
  return loadDay(user.id, today(config.timezone));
}

/**
 * Runs in the browser, including on first load: the page may be a copy the
 * service worker kept, so the device's newer copy (or, offline, its only
 * copy) must get a say before anything renders.
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  return loadDayWithFallback(serverLoader, null);
}
clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return <TrackerSkeleton />;
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Today");
}

export default function Today({ loaderData }: Route.ComponentProps) {
  return <TrackerScreen model={loaderData} />;
}
