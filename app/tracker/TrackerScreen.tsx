import { Alert, Anchor, Grid, Stack } from "@mantine/core";
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
