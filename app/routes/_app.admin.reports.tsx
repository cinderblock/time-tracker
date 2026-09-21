import { Button, Card, Group, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useSearchParams } from "react-router";

import { config } from "../../src/config.server.ts";
import { formatMoney } from "../../src/money.ts";
import { type GroupBy, reportLines, summarize, total } from "../../src/reports.ts";
import { requireApproval } from "../../src/settings.ts";
import { decimalHours, formatDurationHuman, formatWorkDate } from "../../src/time.ts";
import { categoryOptions, jobOptions, peopleOptions, reportQuery } from "../admin.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { pageTitle } from "../meta.ts";
import { RANGE_PRESETS } from "../report-ranges.ts";
import type { Route } from "./+types/_app.admin.reports";

/**
 * Hours and costs over a date range, grouped one way at a time, with the
 * detail as a CSV download.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const url = new URL(request.url);
  const query = reportQuery(url);
  const lines = reportLines(query.filter);
  return {
    query: { ...query, filter: undefined },
    csvHref: `/admin/reports.csv${url.search}`,
    currency: config.currency,
    // Only the word for it changes: with approval off, time is final once its
    // owner submits it.
    signedOffLabel: requireApproval() ? "Approved" : "Submitted",
    groups: summarize(lines, query.by),
    total: total(lines),
    people: peopleOptions(),
    categories: categoryOptions(),
    jobs: jobOptions(),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Reports");
}

const GROUP_LABELS: Record<GroupBy, string> = {
  person: "Person",
  customer: "Customer",
  job: "Job",
  category: "Category",
  day: "Day",
};

const GROUP_ONE: Record<GroupBy, string> = {
  person: "person",
  customer: "customer",
  job: "job",
  category: "category",
  day: "day",
};

const GROUP_MANY: Record<GroupBy, string> = {
  person: "people",
  customer: "customers",
  job: "jobs",
  category: "categories",
  day: "days",
};

export default function Reports({ loaderData }: Route.ComponentProps) {
  const { query, groups, currency, signedOffLabel } = loaderData;
  const sum = loaderData.total;
  const [params, setParams] = useSearchParams();
  const max = Math.max(1, ...groups.map((g) => g.seconds));
  const money = (n: number) => formatMoney(n, currency);

  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { preventScrollReset: true });
  };

  return (
    <Stack gap="lg" maw={1000}>
      <Group justify="space-between" align="center">
        <Title order={2}>Reports</Title>
        <Button component="a" href={loaderData.csvHref} download variant="light">
          Download CSV
        </Button>
      </Group>

      <Card withBorder>
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="sm">
            <Select
              label="Dates"
              data={RANGE_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              value={query.range}
              allowDeselect={false}
              onChange={(v) =>
                set(v === "custom" ? { range: v, from: query.from, to: query.to } : { range: v, from: null, to: null })
              }
            />
            {query.range === "custom" && (
              <>
                <TextInput
                  type="date"
                  label="From"
                  defaultValue={query.from}
                  key={`from-${query.from}`}
                  onChange={(e) => e.currentTarget.value && set({ from: e.currentTarget.value })}
                />
                <TextInput
                  type="date"
                  label="To"
                  defaultValue={query.to}
                  key={`to-${query.to}`}
                  onChange={(e) => e.currentTarget.value && set({ to: e.currentTarget.value })}
                />
              </>
            )}
            <Select
              label="Group by"
              data={Object.entries(GROUP_LABELS).map(([value, label]) => ({ value, label }))}
              value={query.by}
              allowDeselect={false}
              onChange={(v) => set({ by: v === "person" ? null : v })}
            />
            <Select
              label="Person"
              placeholder="Everyone"
              data={loaderData.people}
              value={query.personId != null ? String(query.personId) : null}
              onChange={(v) => set({ person: v })}
              clearable
              searchable
            />
            <Select
              label="Category"
              placeholder="Any"
              data={loaderData.categories}
              value={query.categoryId != null ? String(query.categoryId) : null}
              onChange={(v) => set({ category: v })}
              clearable
              disabled={loaderData.categories.length === 0}
            />
            <Select
              label="Job"
              placeholder="Any job"
              description="Includes its sub-jobs"
              data={loaderData.jobs}
              value={query.jobId}
              onChange={(v) => set({ job: v })}
              clearable
              searchable
            />
          </SimpleGrid>
          <Text size="sm" c="dimmed">
            {formatWorkDate(query.from, { withYear: true })} – {formatWorkDate(query.to, { withYear: true })}
          </Text>
        </Stack>
      </Card>

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        <Stat label="Hours" value={formatDurationHuman(sum.seconds)} detail={`${decimalHours(sum.seconds)} h`} />
        <Stat
          label={signedOffLabel}
          value={formatDurationHuman(sum.signedOffSeconds)}
          detail={sum.seconds ? `${Math.round((sum.signedOffSeconds / sum.seconds) * 100)}% of hours` : "–"}
        />
        <Stat
          label="Cost"
          value={money(sum.cost)}
          detail={sum.unratedSeconds ? `${formatDurationHuman(sum.unratedSeconds)} has no rate` : "All time has a rate"}
        />
        <Stat
          label="Entries"
          value={String(sum.entries)}
          detail={sum.running ? "Includes a running timer" : `${groups.length} ${(groups.length === 1 ? GROUP_ONE : GROUP_MANY)[query.by]}`}
        />
      </SimpleGrid>

      {groups.length === 0 ? (
        <Text c="dimmed">No time recorded for these dates and filters.</Text>
      ) : (
        <Table verticalSpacing="xs" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{GROUP_LABELS[query.by]}</Table.Th>
              <Table.Th ta="right">Hours</Table.Th>
              <Table.Th ta="right" visibleFrom="sm">
                {signedOffLabel}
              </Table.Th>
              <Table.Th ta="right">Cost</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {groups.map((g) => (
              <Table.Tr key={g.key}>
                <Table.Td>
                  <Text size="sm" fw={500}>
                    {query.by === "day" ? formatWorkDate(g.label) : g.label}
                  </Text>
                  <ShareBar seconds={g.seconds} signedOff={g.signedOffSeconds} max={max} />
                </Table.Td>
                <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {formatDurationHuman(g.seconds)}
                  <Text size="xs" c="dimmed">
                    {decimalHours(g.seconds)} h
                  </Text>
                  <Text size="xs" c="dimmed" hiddenFrom="sm">
                    {formatDurationHuman(g.signedOffSeconds)} {signedOffLabel.toLowerCase()}
                  </Text>
                </Table.Td>
                <Table.Td ta="right" visibleFrom="sm" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {formatDurationHuman(g.signedOffSeconds)}
                </Table.Td>
                <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {money(g.cost)}
                  {g.unratedSeconds > 0 && (
                    <Text size="xs" c="dimmed">
                      + {formatDurationHuman(g.unratedSeconds)} unrated
                    </Text>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
          <Table.Tfoot>
            <Table.Tr>
              <Table.Th>Total</Table.Th>
              <Table.Th ta="right">{formatDurationHuman(sum.seconds)}</Table.Th>
              <Table.Th ta="right" visibleFrom="sm">
                {formatDurationHuman(sum.signedOffSeconds)}
              </Table.Th>
              <Table.Th ta="right">{money(sum.cost)}</Table.Th>
            </Table.Tr>
          </Table.Tfoot>
        </Table>
      )}

      <Text size="sm" c="dimmed">
        Submitted time is costed at the rate frozen when it was submitted; everything else at today's rates, so its
        cost can still change. Running timers count up to now. Set rates under Rates &amp; categories.
      </Text>
    </Stack>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card withBorder padding="sm">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="xl" fw={700} style={{ fontVariantNumeric: "tabular-nums" }}>
        {value}
      </Text>
      <Text size="xs" c="dimmed">
        {detail}
      </Text>
    </Card>
  );
}

/** Each group's hours against the biggest group's, signed-off part solid. The numbers sit beside it. */
function ShareBar({ seconds, signedOff, max }: { seconds: number; signedOff: number; max: number }) {
  const whole = (seconds / max) * 100;
  const solid = seconds ? (signedOff / seconds) * whole : 0;
  return (
    <div aria-hidden style={{ display: "flex", height: 6, marginTop: 4, borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: `${solid}%`, background: "var(--mantine-color-teal-filled)" }} />
      <div style={{ width: `${whole - solid}%`, background: "var(--mantine-color-teal-light)" }} />
    </div>
  );
}
