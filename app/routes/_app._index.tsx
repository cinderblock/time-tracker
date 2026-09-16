import { config } from "../../src/config.server.ts";
import { today } from "../../src/time.ts";
import { requireUser } from "../auth.server.ts";
import { loadDay } from "../tracker.server.ts";
import { TrackerScreen } from "../tracker/TrackerScreen.tsx";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app._index";

/** Home: today's tracking screen. */
export function loader({ request, context }: Route.LoaderArgs) {
  const { user } = requireUser(context, request);
  return loadDay(user.id, today(config.timezone));
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Today");
}

export default function Today({ loaderData }: Route.ComponentProps) {
  return <TrackerScreen model={loaderData} />;
}
