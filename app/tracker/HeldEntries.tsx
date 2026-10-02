import { Alert, Anchor, Button, Card, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Link } from "react-router";

import { isEditable } from "../../src/entry-status.ts";
import { jobLabel } from "../../src/job-names.ts";
import { formatClock, formatDurationHuman, formatWorkDate } from "../../src/time.ts";
import appear from "../components/appear.module.css";
import { useTracker } from "./context.tsx";
import type { EntryView } from "./model.ts";

/**
 * Time the accounting system already has.
 *
 * Before an entry is first sent, the sync asks what QuickBooks has for that
 * person and day; a record on the same job that didn't come from here holds
 * the entry (sync.ts). The person whose time it is knows whether it's the
 * same work, so this is where it's settled: their entry next to QuickBooks'
 * record, and the ways out, each with what it does.
 */

/** Held entries on this day: signed off, and waiting on an answer. */
function heldOn(entries: EntryView[]): EntryView[] {
  return entries.filter((e) => e.heldBy && e.heldBy.length > 0 && !isEditable(e.status));
}

/** Other days waiting, linked. Sits under the day header so it's seen whichever day is open. */
export function HeldDaysNotice() {
  const { model, hrefFor } = useTracker();
  const days = model.heldDays ?? [];
  if (days.length === 0) return null;
  return (
    <Alert
      color="orange"
      className={appear.appear}
      title={`QuickBooks already has time on ${days.length === 1 ? "a day" : `${days.length} days`} you submitted`}
    >
      <Text size="sm">
        {days.slice(0, 5).map((date, i) => (
          <span key={date}>
            {i > 0 && ", "}
            <Anchor component={Link} to={hrefFor(date)} size="sm">
              {formatWorkDate(date)}
            </Anchor>
          </span>
        ))}
        {days.length > 5 && ` and ${days.length - 5} more`}. Open a day to compare the two and choose what to do; that time
        isn't sent until you do.
      </Text>
    </Alert>
  );
}

/** The comparison and the choices, for each held entry on the day shown. */
export function HeldEntries() {
  const { model } = useTracker();
  const held = heldOn(model.entries);
  if (held.length === 0) return null;
  return (
    <Stack gap="sm" id="held" className={appear.appear}>
      <Stack gap={0}>
        <Title order={3}>QuickBooks already has time for this day</Title>
        <Text size="sm" c="dimmed">
          For each entry below, QuickBooks has a record for you on the same job and day that didn't come from here — from
          QuickBooks Time, or typed in there. Nothing is sent until you say which it is.
        </Text>
      </Stack>
      {held.map((e) => (
        <HeldEntry key={e.id} entry={e} />
      ))}
    </Stack>
  );
}

function HeldEntry({ entry }: { entry: EntryView }) {
  const { model, dispatch, pending } = useTracker();
  const found = entry.heldBy ?? [];
  const tz = model.timezone;
  const span =
    entry.startedAt != null && entry.endedAt != null ? `${formatClock(entry.startedAt, tz)} – ${formatClock(entry.endedAt, tz)}` : null;

  async function answer(action: "replace" | "discard" | "separate" | "recheck", txnId?: string) {
    const result = await dispatch("duplicate.resolve", { entryId: entry.id, action, txnId });
    if (!result.ok) return;
    notifications.show({
      color: action === "discard" ? "red" : "teal",
      message: {
        replace: "QuickBooks' record will be changed to match this entry.",
        discard: "Deleted here. QuickBooks keeps its record.",
        separate: "Both stay. This entry will be sent as well.",
        recheck: "It will be checked again at the next contact with QuickBooks.",
      }[action],
    });
  }

  return (
    <Card withBorder padding="md" role="group" aria-label={`${jobLabel(entry.jobName)}: QuickBooks already has time`}>
      <Stack gap="md">
        <Text fw={500}>{jobLabel(entry.jobName)}</Text>

        <SimpleGrid cols={2} spacing="md">
          <Column heading="Here">
            <Text fw={600}>{formatDurationHuman(entry.durationSeconds)}</Text>
            {span && (
              <Text size="sm" c="dimmed">
                {span}
              </Text>
            )}
            <Note text={entry.note} />
          </Column>
          <Column heading="In QuickBooks">
            {found.map((r) => (
              <Stack key={r.txnId} gap={2}>
                <Text fw={600}>{formatDurationHuman(r.minutes * 60)}</Text>
                <Note text={r.notes} />
                {found.length > 1 && (
                  <Button size="compact-xs" variant="light" disabled={pending} onClick={() => void answer("replace", r.txnId)}>
                    Replace this one with mine
                  </Button>
                )}
              </Stack>
            ))}
          </Column>
        </SimpleGrid>

        <Stack gap="sm">
          <Choice
            label="Same work — keep mine, replace QuickBooks' record"
            what="QuickBooks' record is changed to match this entry: its hours and its note."
            disabled={pending || found.length !== 1}
            onClick={() => void answer("replace", found[0]?.txnId)}
            hint={found.length > 1 ? "Several records there: pick which one above." : undefined}
          />
          <Choice
            label="Same work — keep QuickBooks', delete mine"
            what="This entry is deleted here. QuickBooks keeps what it has."
            color="red"
            disabled={pending}
            onClick={() => void answer("discard")}
          />
          <Choice
            label="Different work — send both"
            what="QuickBooks keeps its record, and this entry is sent as another one."
            disabled={pending}
            onClick={() => void answer("separate")}
          />
          <Choice
            label="I removed it from QuickBooks — check again"
            what="If you deleted the record in QuickBooks Desktop (and in QuickBooks Time, if it came from there, so it isn't sent again), this clears at the next contact."
            disabled={pending}
            onClick={() => void answer("recheck")}
          />
        </Stack>
        <Text size="xs" c="dimmed">
          Not sure? An admin can answer this from the Accounting page. Nothing is sent until someone does.
        </Text>
      </Stack>
    </Card>
  );
}

function Column({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Stack gap={4} style={{ minWidth: 0 }}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {heading}
      </Text>
      {children}
    </Stack>
  );
}

function Note({ text }: { text: string | null }) {
  const trimmed = text?.trim() ?? "";
  return trimmed ? (
    <Text size="sm" lineClamp={4} style={{ overflowWrap: "anywhere" }}>
      {trimmed}
    </Text>
  ) : (
    <Text size="sm" c="dimmed" fs="italic">
      No note
    </Text>
  );
}

/** One way out: the button, and in a line under it what it does. */
function Choice({
  label,
  what,
  hint,
  color,
  disabled,
  onClick,
}: {
  label: string;
  what: string;
  hint?: string;
  color?: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Stack gap={2}>
      {/* A long label on a narrow screen wraps rather than being cut off: a
          choice whose words can't be read isn't a choice. */}
      <Button
        variant="light"
        color={color}
        disabled={disabled}
        onClick={onClick}
        fullWidth
        justify="start"
        h="auto"
        py={8}
        styles={{ label: { whiteSpace: "normal", textAlign: "left", lineHeight: 1.3 } }}
      >
        {label}
      </Button>
      <Text size="xs" c="dimmed">
        {hint ?? what}
      </Text>
    </Stack>
  );
}
