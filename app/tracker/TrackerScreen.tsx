import { Alert, Anchor, Card, Grid, Skeleton, Stack } from "@mantine/core";
import { Link } from "react-router";

import { formatDurationHuman } from "../../src/time.ts";
import { TrackerProvider, useNow, useTracker } from "./context.tsx";
import { DayHeader, dayHref } from "./DayHeader.tsx";
import { EntryList } from "./EntryList.tsx";
import { type DayModel, liveSeconds } from "./model.ts";
import { NotesPanel } from "./NotesPanel.tsx";
import { TimerPanel } from "./TimerCard.tsx";

/**
 * The tracking screen for one day. On a phone everything stacks, timer
 * first; on a wide screen the timer and notes sit beside the day's entries.
 */
export function TrackerScreen({ model }: { model: DayModel }) {
  return (
    <TrackerProvider model={model}>
      <Stack gap="lg" maw={1100}>
        <DayHeader />
        <OfflineNotice />
        <Grid gap="lg">
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Stack gap="lg">
              {model.workDate === model.today ? <TimerPanel /> : <OpenTimerElsewhere />}
              <NotesPanel />
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
  const { model } = useTracker();
  const now = useNow();
  const open = model.open;
  if (!open) return null;
  return (
    <Alert color="green" title="A timer is running">
      {open.jobName} — {formatDurationHuman(now === undefined ? open.durationSeconds : liveSeconds(open, now))}.{" "}
      <Anchor component={Link} to={dayHref(model.today, model.today)}>
        Go to today
      </Anchor>
    </Alert>
  );
}
