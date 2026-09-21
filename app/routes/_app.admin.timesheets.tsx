import { Anchor, Badge, Button, Group, Select, Stack, Text } from "@mantine/core";
import { Link, useFetcher, useSearchParams } from "react-router";

import { approveEntries, describeSignOff, reopenEntries, submitEntries } from "../../src/approvals.ts";
import { timesheet } from "../../src/reports.ts";
import { requireApproval } from "../../src/settings.ts";
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
 * Everyone's week at a glance, and where an admin can act on it: submit for
 * someone who hasn't, approve where the organisation requires approval, or
 * reopen time that needs fixing — a person's whole week in one tap, or
 * everyone's at once.
 *
 * People submit their own time; this page is the safety net, not the route
 * time normally takes.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const week = weekFromUrl(request);
  const categoryId = idParam(new URL(request.url), "category");
  return {
    ...week,
    categoryId,
    categories: categoryOptions(),
    approvalRequired: requireApproval(),
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
    submit: (form): ActionResult => {
      const user = person(form);
      const result = submitEntries({ userId: user.id, ...weekField(form), actorUserId: me.id });
      return { ok: true, message: `${user.name}: ${describeSignOff("submit", result)}` };
    },
    approve: (form): ActionResult => {
      const user = person(form);
      const result = approveEntries({ userId: user.id, ...weekField(form), actorUserId: me.id });
      return { ok: true, message: `${user.name}: ${describeSignOff("approve", result)}` };
    },
    reopen: (form): ActionResult => {
      const user = person(form);
      const result = reopenEntries({ userId: user.id, ...weekField(form), actorUserId: me.id });
      return { ok: true, message: `${user.name}: ${describeSignOff("reopen", result)}` };
    },
    // Whether this approves or submits is the organisation's setting to decide,
    // not the page's: approving covers time nobody submitted, so where approval
    // is required one pass is enough.
    "sign-off-all": (form): ActionResult => {
      const range = weekField(form);
      const approving = requireApproval();
      const ids = stringField(form, "userIds").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const total = { changed: 0, unchanged: 0, skipped: 0 };
      for (const id of ids) {
        const r = approving
          ? approveEntries({ userId: id, ...range, actorUserId: me.id })
          : submitEntries({ userId: id, ...range, actorUserId: me.id });
        total.changed += r.changed;
        total.unchanged += r.unchanged;
        total.skipped += r.skipped;
      }
      return { ok: true, message: describeSignOff(approving ? "approve" : "submit", total) };
    },
  });
}

type Data = Route.ComponentProps["loaderData"];
type Row = Data["rows"][number];

export default function Timesheets({ loaderData }: Route.ComponentProps) {
  const { weekStart, thisWeek, today, days, rows, categories, categoryId, approvalRequired } = loaderData;
  const [params, setParams] = useSearchParams();
  const all = useFetcher<typeof action>();
  useActionFeedback(all.data);
  // What the bulk action would act on: everything not yet submitted, plus —
  // where approval is required — everything submitted and still waiting.
  const waiting = (r: Row) => r.unsubmitted + (approvalRequired ? r.submitted : 0);
  const withWaiting = rows.filter((r) => waiting(r) > 0);
  const waitingCount = withWaiting.reduce((n, r) => n + waiting(r), 0);
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
            {waitingCount > 0
              ? ` · ${waitingCount} ${waitingCount === 1 ? "entry" : "entries"} ${approvalRequired ? "to approve" : "not submitted"}`
              : ""}
          </Text>
          <all.Form method="post">
            <input type="hidden" name="intent" value="sign-off-all" />
            <input type="hidden" name="weekStart" value={weekStart} />
            <input type="hidden" name="userIds" value={withWaiting.map((r) => r.userId).join(",")} />
            <Button type="submit" disabled={waitingCount === 0} loading={all.state !== "idle"}>
              {approvalRequired ? "Approve everyone shown" : "Submit for everyone shown"}
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
          rows.map((row) => (
            <PersonRow
              key={row.userId}
              row={row}
              weekStart={weekStart}
              today={today}
              approvalRequired={approvalRequired}
            />
          ))
        )}
      </Stack>

      <Text size="sm" c="dimmed">
        Tap a day to see or fix that person's time. Submitted days are shaded; a green outline means a timer is
        running. People submit their own time — submitting freezes its rate and locks it
        {approvalRequired ? ", and it waits here for approval" : " and sends it to accounting"}. Submit for someone
        who hasn't got to it, and reopen a week that needs fixing.
      </Text>
    </Stack>
  );
}

function PersonRow({
  row,
  weekStart,
  today,
  approvalRequired,
}: {
  row: Row;
  weekStart: string;
  today: string;
  approvalRequired: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const busy = fetcher.state !== "idle";
  const act = (intent: "submit" | "approve" | "reopen") =>
    fetcher.submit({ intent, userId: String(row.userId), weekStart }, { method: "post" });

  // One action, because approving covers time nobody submitted: where approval
  // is required an admin approves the lot, and where it isn't they submit for
  // someone who hasn't. Anything signed off can be reopened.
  const waiting = approvalRequired ? row.unsubmitted + row.submitted : row.unsubmitted;
  const signedOff = row.submitted + row.approved;
  const verb = approvalRequired ? "Approve" : "Submit";
  const status = (
    <Group gap={6} wrap="wrap" justify="flex-end">
      {waiting > 0 ? (
        <Button
          size="compact-sm"
          onClick={() => act(approvalRequired ? "approve" : "submit")}
          loading={busy}
          aria-label={`${verb} ${row.name}'s week`}
        >
          {verb} {waiting}
        </Button>
      ) : (
        signedOff > 0 && (
          <Badge color="teal" variant="light">
            {approvalRequired ? "approved" : "submitted"}
          </Badge>
        )
      )}
      {signedOff > 0 && (
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => act("reopen")}
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
        // Shaded once the day is as far as this organisation takes it: through
        // approval where that's required, through submission where it isn't.
        const done =
          d.entries > 0 &&
          d.unsubmitted === 0 &&
          (approvalRequired ? d.submitted === 0 && d.approved > 0 : d.submitted + d.approved > 0);
        const state = d.running ? "running" : done ? "approved" : "open";
        const text = d.entries ? clockHours(d.seconds) : "–";
        // A day with a timer still on it isn't reported as done, whatever the
        // rest of it says.
        const said = d.unsubmitted
          ? `, ${d.unsubmitted} ${approvalRequired ? "to approve" : "not submitted"}`
          : state === "approved"
            ? d.approved > 0
              ? ", approved"
              : ", submitted"
            : "";
        const label = `${row.name}, ${formatWorkDate(d.date)}: ${d.seconds ? formatDurationHuman(d.seconds) : "no time"}${said}`;
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
