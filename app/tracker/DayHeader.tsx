import { Button, Group, SimpleGrid, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { Link } from "react-router";

import { addDays, formatDurationHuman, formatWorkDate, weekdayOf } from "../../src/time.ts";
import { useNow, useTracker } from "./context.tsx";
import { liveSeconds } from "./model.ts";

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

/** Which day is shown, how to move between days, and the week at a glance. */
export function DayHeader() {
  const { model, hrefFor } = useTracker();
  const { workDate, today } = model;
  const isToday = workDate === today;
  // In notes mode a day's notes have to become time before moving on from it.
  const heldHere = model.mode === "notes" && model.notes.some((n) => !n.rolledIntoEntryId);
  const canGoForward = workDate < today && !heldHere;
  // Totals come from the server; add the running timer's live time to its day
  // so the strip agrees with the list below it.
  const now = useNow(30_000);
  const open = model.open;
  const running = open && now !== undefined ? liveSeconds(open, now) - open.durationSeconds : 0;
  const week = model.week.map((d) => (open && d.date === open.workDate ? { ...d, seconds: d.seconds + running } : d));

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <Button
          component={Link}
          to={hrefFor(addDays(workDate, -1))}
          variant="default"
          size="sm"
          aria-label="Previous day"
        >
          ‹
        </Button>
        <Stack gap={0} align="center">
          <Title order={2} ta="center">
            {isToday ? "Today" : formatWorkDate(workDate, { withYear: workDate.slice(0, 4) !== today.slice(0, 4) })}
          </Title>
          {isToday ? (
            <Text size="sm" c="dimmed">
              {formatWorkDate(workDate)}
            </Text>
          ) : (
            <Button component={Link} to={hrefFor(today)} variant="subtle" size="compact-sm">
              Back to today
            </Button>
          )}
        </Stack>
        {canGoForward ? (
          <Button component={Link} to={hrefFor(addDays(workDate, 1))} variant="default" size="sm" aria-label="Next day">
            ›
          </Button>
        ) : (
          // A real disabled button: a "disabled" link would still navigate.
          <Button variant="default" size="sm" aria-label="Next day" disabled>
            ›
          </Button>
        )}
      </Group>
      {heldHere && workDate < today && (
        <Text size="xs" c="dimmed" ta="center">
          Turn this day's notes into time to move on.
        </Text>
      )}

      <SimpleGrid cols={7} spacing={4}>
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
