import { ActionIcon, Button, Group, SimpleGrid, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { Link } from "react-router";

import { formatDurationHuman, formatWorkDate, weekdayOf } from "../../src/time.ts";
import { Chevron } from "../components/chevron.tsx";
import { useNow, useTracker } from "./context.tsx";
import classes from "./DayHeader.module.css";
import { type DayMove, markDayMove, moveBetween } from "./day-move.ts";
import { daySteps } from "./day-steps.ts";
import { isPendingNote, liveSeconds } from "./model.ts";

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
  facing,
  move,
  double = false,
}: {
  to: string | null;
  label: string;
  facing: "left" | "right";
  /** How the screen moves when pressed; a day's step off the end of the strip is a week move. */
  move: DayMove;
  double?: boolean;
}) {
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
  // In notes mode a day's notes have to become time before moving on from it —
  // unless the person has turned that hold off.
  const heldHere = model.mode === "notes" && model.notesHold && model.notes.some(isPendingNote);
  const weekStart = model.week[0]?.date ?? workDate;
  const steps = daySteps({ workDate, today, weekStart, heldHere });
  const moveTo = (date: string) => moveBetween(workDate, date, weekStart);
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
          <ArrowButton to={hrefFor(steps.previousWeek)} label="Previous week" facing="left" move={moveTo(steps.previousWeek)} double />
          <ArrowButton to={hrefFor(steps.previousDay)} label="Previous day" facing="left" move={moveTo(steps.previousDay)} />
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
                onClick={() => markDayMove(moveTo(today))}
                variant="subtle"
                size="compact-sm"
              >
                Back to today
              </Button>
            )}
          </div>
        </Stack>
        <Group gap={6} wrap="nowrap">
          <ArrowButton
            to={steps.nextDay && hrefFor(steps.nextDay)}
            label="Next day"
            facing="right"
            move={steps.nextDay ? moveTo(steps.nextDay) : "day-later"}
          />
          <ArrowButton
            to={steps.nextWeek && hrefFor(steps.nextWeek)}
            label="Next week"
            facing="right"
            move={steps.nextWeek ? moveTo(steps.nextWeek) : "week-later"}
            double
          />
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
          const cell = {
            className: classes.cell,
            "data-today": d.date === today ? "" : undefined,
            "data-future": future ? "" : undefined,
          };
          const label = (
            <>
              {/* The highlight, as a layer that can travel: see day-move.css. */}
              {selected && <span className={classes.selected} data-day-part="selected" aria-hidden />}
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
            <div key={d.date} {...cell} aria-hidden>
              {label}
            </div>
          ) : (
            <UnstyledButton
              key={d.date}
              component={Link}
              to={hrefFor(d.date)}
              viewTransition
              onClick={() => markDayMove(moveTo(d.date))}
              aria-label={`${formatWorkDate(d.date)}: ${formatDurationHuman(d.seconds)}`}
              aria-current={selected ? "date" : undefined}
              {...cell}
            >
              {label}
            </UnstyledButton>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}
