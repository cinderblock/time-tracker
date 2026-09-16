import { Anchor, Group } from "@mantine/core";
import { useMemo } from "react";
import { Link, data } from "react-router";

import { config } from "../../src/config.server.ts";
import { formatWorkDate, isWorkDate, today } from "../../src/time.ts";
import { getUser } from "../../src/users.ts";
import { requireAdmin } from "../auth.server.ts";
import { pageTitle } from "../meta.ts";
import { loadDay } from "../tracker.server.ts";
import { TrackerScreen } from "../tracker/TrackerScreen.tsx";
import type { Route } from "./+types/_app.admin.people.$userId.time";

/**
 * Someone else's day, on the same tracking screen, for an admin to fill in
 * or fix. Changes go to the admin ops endpoint and need a connection.
 */
export function loader({ request, context, params }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const person = getUser(Number(params.userId));
  if (!person) throw data("There's nobody with that id.", { status: 404 });
  const todayDate = today(config.timezone);
  const date = params.date ?? todayDate;
  if (!isWorkDate(date)) throw data("That isn't a date.", { status: 404 });
  if (date > todayDate) throw data("That day hasn't happened yet.", { status: 404 });
  return { person: { id: person.id, name: person.name }, model: loadDay(person.id, date) };
}

/** Stamp when the copy was asked for, so changes confirmed before then stop being overlaid. */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  const fetchedAt = Date.now();
  const loaded = await serverLoader();
  return { ...loaded, model: { ...loaded.model, fetchedAt } };
}

export function meta({ loaderData, matches }: Route.MetaArgs) {
  if (!loaderData) return pageTitle(matches, "Time");
  const { person, model } = loaderData;
  const day = model.workDate === model.today ? "today" : formatWorkDate(model.workDate, { withYear: true });
  return pageTitle(matches, `${person.name}, ${day}`);
}

export default function PersonTime({ loaderData }: Route.ComponentProps) {
  const { person, model } = loaderData;
  const actingFor = useMemo(
    () => ({ userId: person.id, name: person.name, basePath: `/admin/people/${person.id}/time` }),
    [person.id, person.name],
  );
  return (
    <>
      <Group gap="md" mb="sm">
        <Anchor component={Link} to={`/admin/people/${person.id}`} size="sm">
          ‹ {person.name}
        </Anchor>
        <Anchor component={Link} to={`/admin/timesheets?week=${model.workDate}`} size="sm">
          Timesheets for this week
        </Anchor>
      </Group>
      <TrackerScreen
        // A different person or day is a different screen: start its state afresh.
        key={`${person.id}/${model.workDate}`}
        model={model}
        actingFor={actingFor}
      />
    </>
  );
}
