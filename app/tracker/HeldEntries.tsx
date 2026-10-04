import { Alert, Anchor, Button, Card, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { Link } from "react-router";

import { isEditable } from "../../src/entry-status.ts";
import { jobLabel } from "../../src/job-names.ts";
import { formatClock, formatDurationHuman, formatWorkDate } from "../../src/time.ts";
import appear from "../components/appear.module.css";
import { ClampedText } from "../components/clamped-text.tsx";
import { MOTION } from "../motion.ts";
import { useTracker } from "./context.tsx";
import classes from "./HeldEntries.module.css";
import type { EntryView } from "./model.ts";

/**
 * Time the accounting system already has.
 *
 * Before an entry is first sent, the sync asks what QuickBooks has for that
 * person and day; a record on the same job that didn't come from here holds
 * the entry (sync.ts). The person whose time it is knows whether it's the
 * same work, so this is where it's settled: their entry and QuickBooks'
 * record side by side, each with the choice that keeps it under it, and the
 * two other ways out below. Pointing at a choice shows what it keeps and
 * what it lets go; choosing plays that out (HeldEntries.module.css).
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

type Action = "replace" | "discard" | "separate" | "recheck";
/** What a choice keeps: this app's entry, QuickBooks' record, both, or — checking again — no answer yet. */
type Keep = "mine" | "theirs" | "both" | null;

const KEEPS: Record<Action, Keep> = { replace: "mine", discard: "theirs", separate: "both", recheck: null };

/** How long the choice is seen before it is made: the leave/keep animation's length, or none. */
function playFor(): number {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : MOTION.slow;
}

function HeldEntry({ entry }: { entry: EntryView }) {
  const { model, dispatch, pending } = useTracker();
  const found = entry.heldBy ?? [];
  const tz = model.timezone;
  const span =
    entry.startedAt != null && entry.endedAt != null ? `${formatClock(entry.startedAt, tz)} – ${formatClock(entry.endedAt, tz)}` : null;
  // What the choice under the pointer (or focus) would keep; then, what was chosen.
  const [keep, setKeep] = useState<Keep>(null);
  const [chosen, setChosen] = useState<Keep>(null);
  const busy = pending || chosen != null;

  async function answer(action: Action, txnId?: string) {
    // Seen first, then done: the change takes this card away as soon as it is queued.
    setKeep(null);
    setChosen(KEEPS[action]);
    await new Promise((resolve) => setTimeout(resolve, playFor()));
    const result = await dispatch("duplicate.resolve", { entryId: entry.id, action, txnId });
    if (!result.ok) {
      setChosen(null);
      return;
    }
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

  /** Pointing at a choice previews it; leaving it clears the preview. */
  const previews = (what: Keep) => ({
    onPointerEnter: () => setKeep(what),
    onPointerLeave: () => setKeep(null),
    onFocus: () => setKeep(what),
    onBlur: () => setKeep(null),
  });

  return (
    <Card withBorder padding="md" role="group" aria-label={`${jobLabel(entry.jobName)}: QuickBooks already has time`}>
      <Stack gap="md">
        <Text fw={500}>{jobLabel(entry.jobName)}</Text>

        <div className={classes.compare} data-keep={keep ?? undefined} data-chosen={chosen ?? undefined}>
          <section className={classes.side} data-side="mine" aria-label="Here">
            <Heading>Here</Heading>
            <div className={classes.record}>
              <Text fw={600}>{formatDurationHuman(entry.durationSeconds)}</Text>
              {span && (
                <Text size="sm" c="dimmed">
                  {span}
                </Text>
              )}
              <Note text={entry.note} />
            </div>
            <Choice
              label="Keep mine"
              what="Same work. QuickBooks' record is changed to match this entry: its hours and its note."
              hint={found.length > 1 ? "QuickBooks has several: choose which one to replace, on the right." : undefined}
              disabled={busy || found.length !== 1}
              onClick={() => void answer("replace", found[0]?.txnId)}
              {...previews("mine")}
            />
          </section>

          <section className={classes.side} data-side="theirs" aria-label="In QuickBooks">
            <Heading>In QuickBooks</Heading>
            <div className={classes.record}>
              {found.map((r) => (
                <div key={r.txnId} className={classes.one}>
                  <Text fw={600}>{formatDurationHuman(r.minutes * 60)}</Text>
                  <Note text={r.notes} />
                  {found.length > 1 && (
                    <Button
                      size="compact-xs"
                      variant="light"
                      disabled={busy}
                      onClick={() => void answer("replace", r.txnId)}
                      {...previews("mine")}
                    >
                      Replace this one with mine
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <Choice
              label="Keep QuickBooks'"
              what="Same work. This entry is deleted here; QuickBooks keeps what it has."
              color="red"
              disabled={busy}
              onClick={() => void answer("discard")}
              {...previews("theirs")}
            />
          </section>
        </div>

        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
          <Choice
            label="Different work — send both"
            what="QuickBooks keeps its record, and this entry is sent as another one."
            variant="default"
            disabled={busy}
            onClick={() => void answer("separate")}
            {...previews("both")}
          />
          <Choice
            label="I removed it from QuickBooks — check again"
            what="If you deleted the record in QuickBooks Desktop (and in QuickBooks Time, if it came from there), this clears at the next contact."
            variant="default"
            disabled={busy}
            onClick={() => void answer("recheck")}
          />
        </SimpleGrid>
        <Text size="xs" c="dimmed">
          Not sure? An admin can answer this from the Accounting page. Nothing is sent until someone does.
        </Text>
      </Stack>
    </Card>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
      {children}
    </Text>
  );
}

function Note({ text }: { text: string | null }) {
  const trimmed = text?.trim() ?? "";
  return trimmed ? (
    <ClampedText size="sm" lines={4}>
      {trimmed}
    </ClampedText>
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
  variant = "light",
  disabled,
  onClick,
  ...previews
}: {
  label: string;
  what: string;
  hint?: string;
  color?: string;
  variant?: "light" | "default";
  disabled: boolean;
  onClick: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  return (
    <Stack gap={2} style={{ minWidth: 0 }}>
      {/* A long label on a narrow screen wraps rather than being cut off: a
          choice whose words can't be read isn't a choice. */}
      <Button
        variant={variant}
        color={color}
        disabled={disabled}
        onClick={onClick}
        fullWidth
        justify="start"
        h="auto"
        py={8}
        styles={{ label: { whiteSpace: "normal", textAlign: "left", lineHeight: 1.3 } }}
        {...previews}
      >
        {label}
      </Button>
      <Text size="xs" c="dimmed">
        {hint ?? what}
      </Text>
    </Stack>
  );
}
