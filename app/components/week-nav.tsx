import { ActionIcon, Button, Group, Stack, Text, Title } from "@mantine/core";
import { Link, useSearchParams } from "react-router";

import { addDays, formatWorkDate } from "../../src/time.ts";
import { Chevron } from "./chevron.tsx";

/** "Sep 13 – 19, 2026", or across months "Sep 27 – Oct 3, 2026". */
export function formatWeek(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const month = (d: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" }).format(Date.parse(d));
  const day = (d: string) => Number(d.slice(8));
  const year = end.slice(0, 4);
  const start = `${month(weekStart)} ${day(weekStart)}`;
  const finish = month(end) === month(weekStart) ? `${day(end)}` : `${month(end)} ${day(end)}`;
  return weekStart.slice(0, 4) === year ? `${start} – ${finish}, ${year}` : `${start}, ${weekStart.slice(0, 4)} – ${finish}, ${year}`;
}

/**
 * Previous / next week, keeping the page's other filters. The week is the
 * `week` search parameter; without one, the page shows this week.
 */
export function WeekNav({ weekStart, thisWeek, title }: { weekStart: string; thisWeek: string; title: string }) {
  const [params] = useSearchParams();
  const hrefFor = (start: string) => {
    const next = new URLSearchParams(params);
    if (start === thisWeek) next.delete("week");
    else next.set("week", start);
    const query = next.toString();
    return query ? `?${query}` : "?";
  };
  const isThisWeek = weekStart === thisWeek;

  return (
    <Group justify="space-between" wrap="nowrap" gap="sm">
      <ActionIcon
        component={Link}
        to={hrefFor(addDays(weekStart, -7))}
        variant="default"
        size="lg"
        aria-label="Previous week"
      >
        <Chevron towards="left" />
      </ActionIcon>
      <Stack gap={0} align="center">
        <Title order={2} ta="center">
          {title}
        </Title>
        <Group gap="xs" justify="center">
          <Text size="sm" c="dimmed">
            {isThisWeek ? `This week · ${formatWeek(weekStart)}` : formatWeek(weekStart)}
          </Text>
          {!isThisWeek && (
            <Button component={Link} to={hrefFor(thisWeek)} variant="subtle" size="compact-sm">
              This week
            </Button>
          )}
        </Group>
      </Stack>
      {weekStart < thisWeek ? (
        <ActionIcon
          component={Link}
          to={hrefFor(addDays(weekStart, 7))}
          variant="default"
          size="lg"
          aria-label="Next week"
        >
          <Chevron towards="right" />
        </ActionIcon>
      ) : (
        // A real disabled button: a "disabled" link would still navigate.
        <ActionIcon variant="default" size="lg" aria-label="Next week" disabled>
          <Chevron towards="right" />
        </ActionIcon>
      )}
    </Group>
  );
}

/** Short weekday and day of month: "Wed 16". */
export function dayLabel(date: string): string {
  return formatWorkDate(date).replace(/,.*$/, "") + ` ${Number(date.slice(8))}`;
}
