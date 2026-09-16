import { Button, Group, SimpleGrid, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { Link } from "react-router";

import { addDays, formatDurationHuman, formatWorkDate } from "../../src/time.ts";
import { useNow, useTracker } from "./context.tsx";
import { liveSeconds } from "./model.ts";

export function dayHref(date: string, today: string): string {
  return date === today ? "/" : `/day/${date}`;
}

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

/** Which day is shown, how to move between days, and the week at a glance. */
export function DayHeader() {
  const { model } = useTracker();
  const { workDate, today } = model;
  const isToday = workDate === today;
  const canGoForward = workDate < today;
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
          to={dayHref(addDays(workDate, -1), today)}
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
            <Button component={Link} to="/" variant="subtle" size="compact-sm">
              Back to today
            </Button>
          )}
        </Stack>
        <Button
          component={Link}
          to={dayHref(addDays(workDate, 1), today)}
          variant="default"
          size="sm"
          aria-label="Next day"
          disabled={!canGoForward}
        >
          ›
        </Button>
      </Group>

      <SimpleGrid cols={7} spacing={4}>
        {week.map((d, i) => {
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
                {WEEKDAY[i]}
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
              to={dayHref(d.date, today)}
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
