import { Anchor, Badge, Button, Group, Select, Stack, Text } from "@mantine/core";
import { Link, useFetcher, useSearchParams } from "react-router";

import { approveEntries, describeApproval, reopenEntries } from "../../src/approvals.ts";
import { timesheet } from "../../src/reports.ts";
import { addDays, formatDurationHuman, formatWorkDate, isWorkDate, weekdayOf } from "../../src/time.ts";
import { UserInputError, getUser } from "../../src/users.ts";
import { type ActionResult, handleForm, intField, stringField } from "../actions.server.ts";
import { categoryOptions, idParam, weekFromUrl } from "../admin.server.ts";
import { requireAdmin } from "../auth.server.ts";
import classes from "../components/timesheet.module.css";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { WeekNav, dayLabel } from "../components/week-nav.tsx";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.admin.timesheets";

/**
 * Everyone's week at a glance, and where time gets approved: a person's
 * whole week in one tap, or everyone's at once.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const week = weekFromUrl(request);
  const categoryId = idParam(new URL(request.url), "category");
  return {
    ...week,
    categoryId,
    categories: categoryOptions(),
    ...timesheet(week.weekStart, { categoryId }),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Timesheets");
}

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

/** "7:30" — hours and minutes, narrow enough for a phone's day cell. */
function clockHours(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function weekField(form: FormData): { from: string; to: string } {
  const from = stringField(form, "weekStart");
  if (!isWorkDate(from)) throw new UserInputError("That request was incomplete.");
  return { from, to: addDays(from, 6) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user: me } = requireAdmin(context, request);
  const person = (form: FormData) => {
    const user = getUser(intField(form, "userId"));
    if (!user) throw new UserInputError("That person no longer exists.");
    return user;
  };
  return handleForm(request, {
    approve: (form): ActionResult => {
      const user = person(form);
      const result = approveEntries({ userId: user.id, ...weekField(form), actorUserId: me.id });
      return { ok: true, message: `${user.name}: ${describeApproval("Approved", result)}` };
    },
    reopen: (form): ActionResult => {
      const user = person(form);
      const result = reopenEntries({ userId: user.id, ...weekField(form), actorUserId: me.id });
      return { ok: true, message: `${user.name}: ${describeApproval("Reopened", result)}` };
    },
    "approve-all": (form): ActionResult => {
      const range = weekField(form);
      const ids = stringField(form, "userIds").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const total = { changed: 0, unchanged: 0, skipped: 0 };
      for (const id of ids) {
        const r = approveEntries({ userId: id, ...range, actorUserId: me.id });
        total.changed += r.changed;
        total.unchanged += r.unchanged;
        total.skipped += r.skipped;
      }
      return { ok: true, message: describeApproval("Approved", total) };
    },
  });
}

type Data = Route.ComponentProps["loaderData"];
type Row = Data["rows"][number];

export default function Timesheets({ loaderData }: Route.ComponentProps) {
  const { weekStart, thisWeek, today, days, rows, categories, categoryId } = loaderData;
  const [params, setParams] = useSearchParams();
  const all = useFetcher<typeof action>();
  useActionFeedback(all.data);
  const withDrafts = rows.filter((r) => r.drafts > 0);
  const draftCount = withDrafts.reduce((n, r) => n + r.drafts, 0);
  const weekTotal = rows.reduce((n, r) => n + r.seconds, 0);

  return (
    <Stack gap="lg" maw={1200}>
      <WeekNav weekStart={weekStart} thisWeek={thisWeek} title="Timesheets" />

      <Group justify="space-between" align="end" gap="sm">
        <Select
          label="Category"
          placeholder="Everyone"
          data={categories}
          value={categoryId != null ? String(categoryId) : null}
          clearable
          disabled={categories.length === 0}
          onChange={(value) => {
            const next = new URLSearchParams(params);
            if (value) next.set("category", value);
            else next.delete("category");
            setParams(next);
          }}
          w={220}
        />
        <Group gap="sm" align="center">
          <Text size="sm" c="dimmed">
            {formatDurationHuman(weekTotal)} this week
            {draftCount > 0 ? ` · ${draftCount} ${draftCount === 1 ? "entry" : "entries"} to approve` : ""}
          </Text>
          <all.Form method="post">
            <input type="hidden" name="intent" value="approve-all" />
            <input type="hidden" name="weekStart" value={weekStart} />
            <input type="hidden" name="userIds" value={withDrafts.map((r) => r.userId).join(",")} />
            <Button type="submit" disabled={draftCount === 0} loading={all.state !== "idle"}>
              Approve everyone shown
            </Button>
          </all.Form>
        </Group>
      </Group>

      <Stack gap={6}>
        <div className={classes.header} aria-hidden>
          <Text size="sm" c="dimmed">
            Person
          </Text>
          {days.map((d) => (
            <Text key={d} size="sm" c="dimmed" ta="center" fw={d === today ? 700 : undefined}>
              {dayLabel(d)}
            </Text>
          ))}
          <Text size="sm" c="dimmed" ta="right">
            Total
          </Text>
          <span />
        </div>
        {rows.length === 0 ? (
          <Text c="dimmed">Nobody here yet.</Text>
        ) : (
          rows.map((row) => <PersonRow key={row.userId} row={row} weekStart={weekStart} today={today} />)
        )}
      </Stack>

      <Text size="sm" c="dimmed">
        Tap a day to see or fix that person's time. Approved days are shaded; a green outline means a timer is
        running. Approving locks the time and records its rate; reopen a week to change it again.
      </Text>
    </Stack>
  );
}

function PersonRow({ row, weekStart, today }: { row: Row; weekStart: string; today: string }) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const busy = fetcher.state !== "idle";
  const submit = (intent: "approve" | "reopen") =>
    fetcher.submit({ intent, userId: String(row.userId), weekStart }, { method: "post" });

  // Approve what's waiting; reopen what's approved. A part-approved week offers both.
  const status = (
    <Group gap={6} wrap="wrap" justify="flex-end">
      {row.drafts > 0 ? (
        <Button size="compact-sm" onClick={() => submit("approve")} loading={busy} aria-label={`Approve ${row.name}'s week`}>
          Approve {row.drafts}
        </Button>
      ) : (
        row.approved > 0 && (
          <Badge color="teal" variant="light">
            approved
          </Badge>
        )
      )}
      {row.approved > 0 && (
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => submit("reopen")}
          disabled={busy}
          aria-label={`Reopen ${row.name}'s week`}
        >
          Reopen
        </Button>
      )}
    </Group>
  );

  return (
    <div className={classes.row} aria-label={row.name} role="group">
      <div className={classes.who}>
        <Anchor component={Link} to={`/admin/people/${row.userId}`} fw={500} truncate display="block">
          {row.name}
        </Anchor>
        <Group gap={6}>
          {row.categoryName && (
            <Text size="xs" c="dimmed">
              {row.categoryName}
            </Text>
          )}
          {row.running && (
            <Badge size="xs" color="green" variant="light">
              running
            </Badge>
          )}
          {!row.active && (
            <Badge size="xs" color="gray" variant="light">
              deactivated
            </Badge>
          )}
        </Group>
      </div>
      {row.days.map((d) => {
        const future = d.date > today;
        const state = d.running ? "running" : d.entries > 0 && d.drafts === 0 && d.approved > 0 ? "approved" : "open";
        const text = d.entries ? clockHours(d.seconds) : "–";
        const label = `${row.name}, ${formatWorkDate(d.date)}: ${d.seconds ? formatDurationHuman(d.seconds) : "no time"}${
          state === "approved" ? ", approved" : d.drafts ? `, ${d.drafts} to approve` : ""
        }`;
        const content = (
          <>
            <Text component="span" size="xs" c="dimmed" className={classes.dayLabel}>
              {WEEKDAY[weekdayOf(d.date)]}
            </Text>
            <Text component="span" size="sm" c={d.entries ? undefined : "dimmed"}>
              {text}
            </Text>
          </>
        );
        return future ? (
          <span key={d.date} className={classes.day} style={{ opacity: 0.4 }} aria-hidden>
            {content}
          </span>
        ) : (
          <Link
            key={d.date}
            to={`/admin/people/${row.userId}/time${d.date === today ? "" : `/${d.date}`}`}
            className={classes.day}
            data-state={state}
            data-today={d.date === today}
            aria-label={label}
          >
            {content}
          </Link>
        );
      })}
      <Text className={classes.total} fw={600} style={{ fontVariantNumeric: "tabular-nums" }}>
        {formatDurationHuman(row.seconds)}
      </Text>
      <div className={classes.actions}>{status}</div>
    </div>
  );
}
