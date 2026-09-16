import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { createCategory, deleteCategory, listCategories, renameCategory } from "../../src/categories.ts";
import { config } from "../../src/config.server.ts";
import { listJobs } from "../../src/jobs.ts";
import { CATEGORY_NAME_MAX_LENGTH, MAX_HOURLY_RATE } from "../../src/limits.ts";
import { formatRate } from "../../src/money.ts";
import { RATE_SCOPES, type RateScope } from "../../src/rate-scopes.ts";
import { type Rate, listRates, parseHourlyRate, removeRate, setRate } from "../../src/rates.ts";
import { setWeekStartsOn, weekStartsOn } from "../../src/settings.ts";
import { formatWorkDate, today } from "../../src/time.ts";
import { UserInputError, listUsers } from "../../src/users.ts";
import { handleForm, intField, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.admin.rates";

/**
 * Organisation pay settings: hourly rates, employee categories, and the day
 * weeks start on.
 */

const SCOPE_LABELS: Record<RateScope, string> = {
  global: "Everyone (default)",
  category: "A category",
  user: "A person",
  job: "A job",
  user_job: "A person on a job",
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type RateState = "current" | "upcoming" | "past";

export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const todayDate = today(config.timezone);
  const people = new Map(listUsers().map((u) => [u.id, u]));
  const jobs = new Map(listJobs({ includeInactive: true }).map((j) => [j.id, j]));
  const categories = listCategories();
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));

  const appliesTo = (r: Rate): string => {
    const person = r.userId != null ? (people.get(r.userId)?.name ?? "Someone") : "";
    const job = r.jobId != null ? (jobs.get(r.jobId)?.fullName ?? "A job") : "";
    switch (r.scope) {
      case "global":
        return "Everyone";
      case "category":
        return `${categoryNames.get(r.categoryId!) ?? "A category"} (category)`;
      case "user":
        return person;
      case "job":
        return `${job} (job)`;
      case "user_job":
        return `${person} on ${job}`;
    }
  };

  // Within one target, the latest rate that has started is current.
  const rates = listRates();
  const currentIds = new Set<number>();
  const latest = new Map<string, Rate>();
  for (const r of rates) {
    if (r.effectiveFrom > todayDate) continue;
    const key = `${r.scope}|${r.userId}|${r.jobId}|${r.categoryId}`;
    latest.set(key, r); // rates arrive oldest first
  }
  for (const r of latest.values()) currentIds.add(r.id);

  const order = (s: RateScope) => RATE_SCOPES.indexOf(s);
  return {
    today: todayDate,
    currency: config.currency,
    weekStartsOn: weekStartsOn(),
    categories,
    rates: rates
      .map((r) => ({
        id: r.id,
        scope: r.scope,
        appliesTo: appliesTo(r),
        hourlyRate: r.hourlyRate,
        effectiveFrom: r.effectiveFrom,
        state: (currentIds.has(r.id) ? "current" : r.effectiveFrom > todayDate ? "upcoming" : "past") as RateState,
      }))
      .sort(
        (a, b) =>
          order(b.scope) - order(a.scope) ||
          a.appliesTo.localeCompare(b.appliesTo) ||
          b.effectiveFrom.localeCompare(a.effectiveFrom),
      ),
    people: [...people.values()].filter((u) => u.active).map((u) => ({ value: String(u.id), label: u.name })),
    jobs: [...jobs.values()]
      .filter((j) => j.active)
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((j) => ({ value: j.id, label: j.fullName })),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Rates & categories");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user } = requireAdmin(context, request);
  const actorUserId = user.id;
  const optionalId = (form: FormData, name: string) => (stringField(form, name) ? intField(form, name) : null);
  return handleForm(request, {
    "week-start": (form) => {
      const day = Number(stringField(form, "day"));
      if (!Number.isInteger(day) || day < 0 || day > 6) throw new UserInputError("Pick a day.");
      setWeekStartsOn(day, actorUserId);
      return { ok: true, message: `Weeks now start on ${WEEKDAYS[day]}.` };
    },
    "rate-set": (form) => {
      const rate = setRate({
        scope: stringField(form, "scope") as RateScope,
        userId: optionalId(form, "userId"),
        jobId: stringField(form, "jobId") || null,
        categoryId: optionalId(form, "categoryId"),
        hourlyRate: parseHourlyRate(stringField(form, "hourlyRate")),
        effectiveFrom: stringField(form, "effectiveFrom"),
        actorUserId,
      });
      return {
        ok: true,
        message: `Rate set: ${formatRate(rate.hourlyRate, config.currency)} from ${formatWorkDate(rate.effectiveFrom, { withYear: true })}.`,
      };
    },
    "rate-remove": (form) => {
      removeRate({ id: intField(form, "rateId"), actorUserId });
      return { ok: true, message: "Rate removed." };
    },
    "category-create": (form) => {
      const category = createCategory({ name: stringField(form, "name"), actorUserId });
      return { ok: true, message: `Added “${category.name}”.` };
    },
    "category-rename": (form) => {
      const category = renameCategory({ id: intField(form, "categoryId"), name: stringField(form, "name"), actorUserId });
      return { ok: true, message: `Renamed to “${category.name}”.` };
    },
    "category-delete": (form) => {
      const category = deleteCategory({ id: intField(form, "categoryId"), actorUserId });
      return { ok: true, message: `Deleted “${category.name}”.` };
    },
  });
}

type Data = Route.ComponentProps["loaderData"];

export default function Rates({ loaderData }: Route.ComponentProps) {
  return (
    <Stack gap="xl" maw={860}>
      <Title order={2}>Rates &amp; categories</Title>
      <RatesCard data={loaderData} />
      <CategoriesCard data={loaderData} />
      <WeekStartCard weekStartsOn={loaderData.weekStartsOn} />
    </Stack>
  );
}

function RatesCard({ data }: { data: Data }) {
  const remove = useFetcher<typeof action>();
  useActionFeedback(remove.data);
  return (
    <Stack gap="sm">
      <Title order={3}>Hourly rates</Title>
      <Text size="sm" c="dimmed">
        Rates cost time in reports. When several could apply, the most specific wins: a person on a job, then the job
        (or a job it sits under), then the person, then their category, then everyone. Each rate starts on a date, so
        a raise leaves earlier work at the old rate — and approved time keeps the rate it was approved at.
      </Text>
      <NewRateForm data={data} />
      {data.rates.length === 0 ? (
        <Text c="dimmed">No rates yet.</Text>
      ) : (
        <Table verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Applies to</Table.Th>
              <Table.Th ta="right">Rate</Table.Th>
              <Table.Th>From</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.rates.map((r) => (
              <Table.Tr key={r.id} opacity={r.state === "past" ? 0.6 : 1}>
                <Table.Td>{r.appliesTo}</Table.Td>
                <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {formatRate(r.hourlyRate, data.currency)}
                </Table.Td>
                <Table.Td>
                  <Group gap={6}>
                    <Text size="sm" style={{ whiteSpace: "nowrap" }}>
                      {formatWorkDate(r.effectiveFrom, { withYear: true })}
                    </Text>
                    {r.state !== "past" && (
                      <Badge size="xs" variant="light" color={r.state === "current" ? "teal" : "blue"}>
                        {r.state === "current" ? "current" : "upcoming"}
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td ta="right">
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    disabled={remove.state !== "idle"}
                    aria-label={`Remove ${r.appliesTo} rate from ${formatWorkDate(r.effectiveFrom, { withYear: true })}`}
                    onClick={() => remove.submit({ intent: "rate-remove", rateId: String(r.id) }, { method: "post" })}
                  >
                    Remove
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function NewRateForm({ data }: { data: Data }) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const [scope, setScope] = useState<RateScope>("global");
  const [userId, setUserId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [rate, setRateValue] = useState<number | string>("");
  const [from, setFrom] = useState(data.today);

  // Ready for the next one once saved.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setRateValue("");
  }, [fetcher.state, fetcher.data]);

  const needsPerson = scope === "user" || scope === "user_job";
  const needsJob = scope === "job" || scope === "user_job";
  const needsCategory = scope === "category";

  return (
    <Card withBorder>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="rate-set" />
        <input type="hidden" name="scope" value={scope} />
        <input type="hidden" name="userId" value={needsPerson ? (userId ?? "") : ""} />
        <input type="hidden" name="jobId" value={needsJob ? (jobId ?? "") : ""} />
        <input type="hidden" name="categoryId" value={needsCategory ? (categoryId ?? "") : ""} />
        {/* The number itself, not the formatted text shown in the field. */}
        <input type="hidden" name="hourlyRate" value={String(rate)} />
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <Select
              label="Rate for"
              data={RATE_SCOPES.slice()
                .reverse()
                .map((s) => ({ value: s, label: SCOPE_LABELS[s] }))}
              value={scope}
              allowDeselect={false}
              onChange={(v) => v && setScope(v as RateScope)}
            />
            {needsCategory && (
              <Select
                label="Category"
                data={data.categories.map((c) => ({ value: String(c.id), label: c.name }))}
                value={categoryId}
                onChange={setCategoryId}
                required
                nothingFoundMessage="Add a category below first"
              />
            )}
            {needsPerson && (
              <Select label="Person" data={data.people} value={userId} onChange={setUserId} searchable required />
            )}
            {needsJob && <Select label="Job" data={data.jobs} value={jobId} onChange={setJobId} searchable required />}
          </SimpleGrid>
          <Group align="end" gap="sm">
            <NumberInput
              label="Hourly rate"
              value={rate}
              onChange={setRateValue}
              min={0}
              max={MAX_HOURLY_RATE}
              decimalScale={2}
              fixedDecimalScale
              thousandSeparator=","
              prefix={currencySymbol(data.currency)}
              required
              w={160}
            />
            <TextInput
              type="date"
              name="effectiveFrom"
              label="Starting"
              value={from}
              onChange={(e) => setFrom(e.currentTarget.value)}
              required
              w={180}
            />
            <Button type="submit" loading={fetcher.state !== "idle"}>
              Set rate
            </Button>
          </Group>
        </Stack>
      </fetcher.Form>
    </Card>
  );
}

/** "$" for USD, "€" for EUR, and so on. */
function currencySymbol(currency: string): string {
  const parts = new Intl.NumberFormat("en-US", { style: "currency", currency }).formatToParts(0);
  return parts.find((p) => p.type === "currency")?.value ?? "";
}

function CategoriesCard({ data }: { data: Data }) {
  const create = useFetcher<typeof action>();
  useActionFeedback(create.data);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (create.state === "idle" && create.data?.ok) form.current?.reset();
  }, [create.state, create.data]);

  return (
    <Stack gap="sm">
      <Title order={3}>Categories</Title>
      <Text size="sm" c="dimmed">
        Group people — say, field and shop — to filter timesheets and reports and to give a group its own rate. Put
        someone in a category from their page under People.
      </Text>
      <Card withBorder>
        <create.Form method="post" ref={form}>
          <input type="hidden" name="intent" value="category-create" />
          <Group align="end" gap="xs">
            <TextInput
              name="name"
              label="New category"
              maxLength={CATEGORY_NAME_MAX_LENGTH}
              required
              style={{ flex: 1 }}
            />
            <Button type="submit" loading={create.state !== "idle"}>
              Add category
            </Button>
          </Group>
        </create.Form>
      </Card>
      {data.categories.map((c) => (
        <CategoryRow key={c.id} category={c} />
      ))}
    </Stack>
  );
}

function CategoryRow({ category }: { category: Data["categories"][number] }) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <Card withBorder padding="sm">
      {renaming ? (
        <fetcher.Form method="post" onSubmit={() => setRenaming(false)}>
          <input type="hidden" name="intent" value="category-rename" />
          <input type="hidden" name="categoryId" value={category.id} />
          <Group align="end" gap="xs">
            <TextInput
              name="name"
              label="Name"
              defaultValue={category.name}
              maxLength={CATEGORY_NAME_MAX_LENGTH}
              required
              style={{ flex: 1 }}
            />
            <Button type="submit" size="sm">
              Save
            </Button>
            <Button variant="subtle" size="sm" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </Group>
        </fetcher.Form>
      ) : (
        <Group justify="space-between" wrap="nowrap">
          <div>
            <Text fw={500}>{category.name}</Text>
            <Text size="xs" c="dimmed">
              {category.peopleCount === 1 ? "1 person" : `${category.peopleCount} people`}
            </Text>
          </div>
          <Group gap={4} wrap="nowrap">
            <Button size="compact-xs" variant="subtle" onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </Group>
        </Group>
      )}
      <Modal opened={confirming} onClose={() => setConfirming(false)} title={`Delete “${category.name}”?`} centered>
        <Stack>
          <Text size="sm">
            {category.peopleCount > 0
              ? `${category.peopleCount === 1 ? "The 1 person" : `The ${category.peopleCount} people`} in it will have no category, and its rates are removed. `
              : "Its rates are removed. "}
            Approved time keeps the rates it was approved at.
          </Text>
          <Group justify="end">
            <Button variant="default" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              color="red"
              onClick={() => {
                setConfirming(false);
                fetcher.submit({ intent: "category-delete", categoryId: String(category.id) }, { method: "post" });
              }}
            >
              Delete category
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}

function WeekStartCard({ weekStartsOn }: { weekStartsOn: number }) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  return (
    <Stack gap="sm">
      <Title order={3}>Weeks</Title>
      <Card withBorder>
        <Select
          label="Weeks start on"
          description="Timesheets, the calendar and everyone's week strip use this. Match your payroll week."
          data={WEEKDAYS.map((label, value) => ({ value: String(value), label }))}
          value={String(weekStartsOn)}
          allowDeselect={false}
          disabled={fetcher.state !== "idle"}
          onChange={(v) => v != null && fetcher.submit({ intent: "week-start", day: v }, { method: "post" })}
          maw={260}
        />
      </Card>
    </Stack>
  );
}
