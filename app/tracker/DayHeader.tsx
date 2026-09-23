import { ActionIcon, Button, Group, SimpleGrid, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { Link } from "react-router";

import { formatDurationHuman, formatWorkDate, weekdayOf } from "../../src/time.ts";
import { Chevron } from "../components/chevron.tsx";
import { useNow, useTracker } from "./context.tsx";
import classes from "./DayHeader.module.css";
import { type DayMove, markDayMove, towards } from "./day-move.ts";
import { daySteps } from "./day-steps.ts";
import { liveSeconds } from "./model.ts";

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * One arrow. A week jump is the double chevron, a day the single one.
 *
 * With nowhere to go it is a real disabled button rather than a link that
 * refuses — a "disabled" link still navigates — and it stays on screen rather
 * than disappearing, because a button that vanishes moves the three next to
 * it, which is the shifting this header is trying to be rid of.
 */
function ArrowButton({
  to,
  label,
  move,
  double = false,
}: {
  to: string | null;
  label: string;
  move: DayMove;
  double?: boolean;
}) {
  const facing = move.endsWith("-earlier") ? "left" : "right";
  const icon = <Chevron towards={facing} double={double} />;
  if (!to) {
    return (
      <ActionIcon variant="default" size="lg" aria-label={label} disabled>
        {icon}
      </ActionIcon>
    );
  }
  return (
    <ActionIcon
      component={Link}
      to={to}
      viewTransition
      onClick={() => markDayMove(move)}
      variant="default"
      size="lg"
      aria-label={label}
    >
      {icon}
    </ActionIcon>
  );
}

/** Which day is shown, how to move between days and weeks, and the week at a glance. */
export function DayHeader() {
  const { model, hrefFor } = useTracker();
  const { workDate, today } = model;
  const isToday = workDate === today;
  // In notes mode a day's notes have to become time before moving on from it.
  const heldHere = model.mode === "notes" && model.notes.some((n) => !n.rolledIntoEntryId);
  const steps = daySteps({ workDate, today, weekStart: model.week[0]?.date ?? workDate, heldHere });
  // Totals come from the server; add the running timer's live time to its day
  // so the strip agrees with the list below it.
  const now = useNow(30_000);
  const open = model.open;
  const running = open && now !== undefined ? liveSeconds(open, now) - open.durationSeconds : 0;
  const week = model.week.map((d) => (open && d.date === open.workDate ? { ...d, seconds: d.seconds + running } : d));

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap={6} wrap="nowrap">
          <ArrowButton to={hrefFor(steps.previousWeek)} label="Previous week" move="week-earlier" double />
          <ArrowButton to={hrefFor(steps.previousDay)} label="Previous day" move="day-earlier" />
        </Group>
        <Stack gap={0} align="center" data-day-part="title">
          <Title order={2} ta="center">
            {isToday ? "Today" : formatWorkDate(workDate, { withYear: workDate.slice(0, 4) !== today.slice(0, 4) })}
          </Title>
          <div className={classes.subtitle}>
            {isToday ? (
              <Text size="sm" c="dimmed">
                {formatWorkDate(workDate)}
              </Text>
            ) : (
              <Button
                component={Link}
                to={hrefFor(today)}
                viewTransition
                onClick={() => markDayMove(towards(workDate, today))}
                variant="subtle"
                size="compact-sm"
              >
                Back to today
              </Button>
            )}
          </div>
        </Stack>
        <Group gap={6} wrap="nowrap">
          <ArrowButton to={steps.nextDay && hrefFor(steps.nextDay)} label="Next day" move="day-later" />
          <ArrowButton to={steps.nextWeek && hrefFor(steps.nextWeek)} label="Next week" move="week-later" double />
        </Group>
      </Group>
      {heldHere && workDate < today && (
        <Text size="xs" c="dimmed" ta="center">
          Turn this day's notes into hours to move on.
        </Text>
      )}

      <SimpleGrid cols={7} spacing={4} data-day-part="week">
        {week.map((d) => {
          const selected = d.date === workDate;
          const future = d.date > today;
          const style: React.CSSProperties = {
            display: "block",
            borderRadius: "var(--mantine-radius-sm)",
            padding: "4px 0",
            textAlign: "center",
            opacity: future ? 0.4 : 1,
            background: selected ? "var(--mantine-color-brand-light)" : undefined,
            border: d.date === today ? "1px solid var(--mantine-color-brand-filled)" : "1px solid transparent",
          };
          const label = (
            <>
              <Text size="xs" c="dimmed">
                {WEEKDAY[weekdayOf(d.date)]}
              </Text>
              <Text size="sm" fw={selected ? 700 : 500}>
                {Number(d.date.slice(8))}
              </Text>
              <Text size="xs" c={d.seconds ? undefined : "dimmed"}>
                {d.seconds ? formatDurationHuman(d.seconds) : "–"}
              </Text>
            </>
          );
          // Days that haven't happened aren't links.
          return future ? (
            <div key={d.date} style={style} aria-hidden>
              {label}
            </div>
          ) : (
            <UnstyledButton
              key={d.date}
              component={Link}
              to={hrefFor(d.date)}
              viewTransition
              onClick={() => markDayMove(towards(workDate, d.date))}
              aria-label={`${formatWorkDate(d.date)}: ${formatDurationHuman(d.seconds)}`}
              aria-current={selected ? "date" : undefined}
              style={style}
            >
              {label}
            </UnstyledButton>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}
