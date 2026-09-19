import { Alert, Anchor, Card, Grid, Skeleton, Stack, Text } from "@mantine/core";
import { Link } from "react-router";

import { formatDurationHuman } from "../../src/time.ts";
import { type ActingFor, TrackerProvider, useNow, useTracker } from "./context.tsx";
import { DayHeader } from "./DayHeader.tsx";
import { EntryList } from "./EntryList.tsx";
import { type DayModel, liveSeconds } from "./model.ts";
import { NotesPanel } from "./NotesPanel.tsx";
import { TimerPanel } from "./TimerCard.tsx";

/**
 * The tracking screen for one day. On a phone everything stacks, the way of
 * recording time first — a timer, or the day's notes, whichever the person
 * tracks with; on a wide screen that sits beside the day's entries.
 */
export function TrackerScreen({ model, actingFor }: { model: DayModel; actingFor?: ActingFor }) {
  return (
    <TrackerProvider model={model} actingFor={actingFor}>
      <Stack gap="lg" maw={1100}>
        <ActingForNotice />
        <DayHeader />
        <OfflineNotice />
        <Grid gap="lg">
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Stack gap="lg">
              {model.workDate !== model.today ? (
                <OpenTimerElsewhere />
              ) : model.mode === "notes" ? (
                // Notes mode offers no timer — but one that's running must still be stoppable.
                model.open && <TimerPanel />
              ) : (
                <TimerPanel />
              )}
              <NotesPanel />
              <ModeHint />
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <EntryList />
          </Grid.Col>
        </Grid>
      </Stack>
    </TrackerProvider>
  );
}

/** Which way of tracking is on, and where to change it. */
function ModeHint() {
  const { model, actingFor } = useTracker();
  const notes = model.mode === "notes";
  if (actingFor) {
    return (
      <Text size="xs" c="dimmed">
        {actingFor.name} tracks with {notes ? "notes, turned into time later" : "timers"}.
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      You track with {notes ? "notes, turned into time at the end of the day" : "timers"}.{" "}
      <Anchor component={Link} to="/account#tracking" size="xs">
        Change
      </Anchor>
    </Text>
  );
}

/** Makes it unmistakable whose time is on screen when it isn't yours. */
function ActingForNotice() {
  const { actingFor } = useTracker();
  if (!actingFor) return null;
  return (
    <Alert color="grape" title={`${actingFor.name}'s time`}>
      <Text size="sm">
        Changes here are made to {actingFor.name}'s time and recorded as made by you. They need a connection — nothing
        is kept on this device.
      </Text>
    </Alert>
  );
}

/** Says when the day shown is the device's copy rather than the server's. */
function OfflineNotice() {
  const { model } = useTracker();
  if (!model.offline) return null;
  return (
    <Alert color="yellow" title={model.partial ? "Offline — this day isn't on this device" : "Offline"}>
      {model.partial
        ? "Time already saved for this day can't be shown until you're back online. Anything you add now is kept on this phone and saved when the connection returns."
        : "Showing the copy saved on this device. Keep tracking — changes are saved when the connection returns."}
    </Alert>
  );
}

/** Placeholder while the day loads in the browser. */
export function TrackerSkeleton() {
  return (
    <Stack gap="lg" maw={1100} aria-busy="true" aria-label="Loading">
      <Skeleton height={36} width={180} mx="auto" />
      <Skeleton height={56} />
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card withBorder padding="lg">
            <Stack>
              <Skeleton height={24} width="60%" />
              <Skeleton height={56} />
              <Skeleton height={44} />
            </Stack>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Stack>
            <Skeleton height={72} />
            <Skeleton height={72} />
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

/** On a past day, a running timer is still worth knowing about. */
function OpenTimerElsewhere() {
  const { model, hrefFor } = useTracker();
  const now = useNow();
  const open = model.open;
  if (!open) return null;
  return (
    <Alert color="green" title="A timer is running">
      {open.jobName} — {formatDurationHuman(now === undefined ? open.durationSeconds : liveSeconds(open, now))}.{" "}
      <Anchor component={Link} to={hrefFor(model.today)}>
        Go to today
      </Anchor>
    </Alert>
  );
}
