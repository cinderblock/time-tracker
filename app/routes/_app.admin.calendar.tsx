import { Badge, Group, Select, Stack, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import { config } from "../../src/config.server.ts";
import { APPROVED_STATUSES, SIGNED_OFF_STATUSES } from "../../src/entry-status.ts";
import { calendarWeek } from "../../src/reports.ts";
import { formatClock, formatDurationHuman, formatWorkDate, weekdayOf } from "../../src/time.ts";
import { categoryOptions, idParam, peopleOptions, weekFromUrl } from "../admin.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { type Placed, hourRange, layoutDay } from "../components/calendar-layout.ts";
import classes from "../components/calendar.module.css";
import { WeekNav, dayLabel } from "../components/week-nav.tsx";
import { pageTitle } from "../meta.ts";
import { useNow } from "../tracker/context.tsx";
import type { Route } from "./+types/_app.admin.calendar";

/**
 * Everyone's week as blocks of time on a calendar: who worked when, on what.
 * Pauses show as gaps. Typed-in durations have no times, so they're listed
 * above the grid.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const week = weekFromUrl(request);
  const url = new URL(request.url);
  const personId = idParam(url, "person");
  const categoryId = idParam(url, "category");
  const now = Date.now();
  return {
    ...week,
    now,
    timezone: config.timezone,
    personId,
    categoryId,
    personOptions: peopleOptions(),
    categoryOptions: categoryOptions(),
    ...calendarWeek(week.weekStart, { userIds: personId ? [personId] : undefined, categoryId }, now),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Calendar");
}

type Data = Route.ComponentProps["loaderData"];
type Block = Data["blocks"][number];

const PALETTE = ["blue", "orange", "grape", "teal", "pink", "lime", "indigo", "red", "cyan", "yellow", "violet", "green"];
const colorOf = (userId: number) => PALETTE[userId % PALETTE.length]!;
const HOUR_PX = 44;
const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

export default function Calendar({ loaderData }: Route.ComponentProps) {
  const data = loaderData;
  const { weekStart, thisWeek, today, days, timezone } = data;
  const [params, setParams] = useSearchParams();
  const tick = useNow(60_000);
  const now = tick ?? data.now;
  const names = new Map(data.people.map((p) => [p.userId, p.name]));

  // Phones show one day; start on today, else the first day with any time.
  const busiest = days.find((d) => data.blocks.some((b) => b.workDate === d) || data.untimed.some((u) => u.workDate === d));
  const [picked, setFocus] = useState<string | null>(null);
  // A pick from another week doesn't apply to this one.
  const focus = picked && days.includes(picked) ? picked : days.includes(today) ? today : (busiest ?? weekStart);

  const placedByDay = new Map(days.map((d) => [d, layoutDay(data.blocks, d, timezone, now)]));
  const { first, last } = hourRange([...placedByDay.values()].flat());
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const height = (last - first) * HOUR_PX;

  const setParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next);
  };

  return (
    <Stack gap="lg" maw={1400}>
      <WeekNav weekStart={weekStart} thisWeek={thisWeek} title="Calendar" />

      <Group gap="sm" align="end">
        <Select
          label="Person"
          placeholder="Everyone"
          data={data.personOptions}
          value={data.personId != null ? String(data.personId) : null}
          onChange={(v) => setParam("person", v)}
          clearable
          searchable
          w={220}
        />
        <Select
          label="Category"
          placeholder="Any"
          data={data.categoryOptions}
          value={data.categoryId != null ? String(data.categoryId) : null}
          onChange={(v) => setParam("category", v)}
          clearable
          disabled={data.categoryOptions.length === 0}
          w={180}
        />
      </Group>

      {data.people.length > 1 && (
        <Group gap="xs" aria-label="People this week">
          {data.people.map((p) => (
            <Badge
              key={p.userId}
              variant="light"
              color={colorOf(p.userId)}
              component={Link}
              to={`?${new URLSearchParams({ ...Object.fromEntries(params), person: String(p.userId) })}`}
              style={{ cursor: "pointer", textTransform: "none" }}
            >
              {p.name}
            </Badge>
          ))}
        </Group>
      )}

      <div className={classes.picker} role="tablist" aria-label="Day">
        {days.map((d) => (
          <UnstyledButton
            key={d}
            role="tab"
            aria-selected={d === focus}
            aria-label={formatWorkDate(d)}
            onClick={() => setFocus(d)}
            ta="center"
            py={4}
            style={{
              borderRadius: "var(--mantine-radius-sm)",
              background: d === focus ? "var(--mantine-color-brand-light)" : undefined,
            }}
          >
            <Text size="xs" c="dimmed">
              {WEEKDAY[weekdayOf(d)]}
            </Text>
            <Text size="sm" fw={d === focus ? 700 : 500}>
              {Number(d.slice(8))}
            </Text>
          </UnstyledButton>
        ))}
      </div>

      <div className={classes.grid}>
        <span />
        <div className={classes.days}>
          {days.map((d) => (
            <Text key={d} className={classes.head} data-focus={d === focus} size="sm" fw={d === today ? 700 : 500}>
              {dayLabel(d)}
            </Text>
          ))}
        </div>

        <span />
        <div className={classes.days}>
          {days.map((d) => (
            <Stack key={d} gap={2} className={classes.untimed} data-focus={d === focus}>
              {data.untimed
                .filter((u) => u.workDate === d)
                .map((u) => (
                  <Badge
                    key={u.entryId}
                    variant="light"
                    color={colorOf(u.userId)}
                    size="sm"
                    fullWidth
                    component={Link}
                    to={`/admin/people/${u.userId}/time${d === today ? "" : `/${d}`}`}
                    style={{ cursor: "pointer", textTransform: "none" }}
                  >
                    {names.get(u.userId)} · {formatDurationHuman(u.seconds)} · {u.jobName}
                  </Badge>
                ))}
            </Stack>
          ))}
        </div>

        <div className={classes.ruler} style={{ height }} aria-hidden>
          {hours.map((h) => (
            <span key={h} className={classes.hour} style={{ top: (h - first) * HOUR_PX }}>
              {h === 0 || h === 24 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`}
            </span>
          ))}
        </div>
        <div className={classes.days}>
          {days.map((d) => (
            <div
              key={d}
              className={classes.day}
              data-focus={d === focus}
              data-today={d === today}
              style={{
                height,
                ["--hour-height" as string]: `${HOUR_PX}px`,
              }}
            >
              {placedByDay.get(d)!.map((p, i) => (
                <BlockView key={`${p.item.entryId}-${i}`} placed={p} first={first} date={d} data={data} names={names} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {data.blocks.length + data.untimed.length === 0 && (
        <Text c="dimmed" ta="center">
          No time recorded this week{data.personId || data.categoryId ? " for this selection" : ""}.
        </Text>
      )}
    </Stack>
  );
}

function BlockView({
  placed,
  first,
  date,
  data,
  names,
}: {
  placed: Placed<Block>;
  first: number;
  date: string;
  data: Data;
  names: Map<number, string>;
}) {
  const { item: b, from, to, lane, lanes } = placed;
  const color = colorOf(b.userId);
  const top = ((from - first * 60) / 60) * HOUR_PX;
  const tall = Math.max(((to - from) / 60) * HOUR_PX, 14);
  const name = names.get(b.userId) ?? "Someone";
  const running = b.end == null;
  const signedOff = SIGNED_OFF_STATUSES.has(b.status);
  const said = APPROVED_STATUSES.has(b.status) ? ", approved" : signedOff ? ", submitted" : "";
  const times = `${formatClock(b.start, data.timezone)} – ${running ? "now" : formatClock(b.end!, data.timezone)}`;
  const label = `${name}, ${b.jobName}, ${times}${said}`;

  return (
    <Link
      to={`/admin/people/${b.userId}/time${date === data.today ? "" : `/${date}`}`}
      className={classes.block}
      data-running={running}
      data-signed-off={signedOff}
      aria-label={label}
      style={{
        top,
        height: tall,
        left: `calc(${(lane / lanes) * 100}% + 2px)`,
        width: `calc(${100 / lanes}% - 4px)`,
        ["--block-edge" as string]: `var(--mantine-color-${color}-filled)`,
        ["--block-fill" as string]: `var(--mantine-color-${color}-light)`,
        ["--block-text" as string]: `var(--mantine-color-${color}-light-color)`,
      }}
    >
      <b>{name}</b> {b.jobName}
      {tall >= 40 && (
        <>
          <br />
          {times}
        </>
      )}
    </Link>
  );
}
