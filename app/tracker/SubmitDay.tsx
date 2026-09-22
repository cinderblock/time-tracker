import { Alert, Anchor, Button, Card, Group, Stack, Text } from "@mantine/core";
import { Link } from "react-router";

import { isOwnerReopenable } from "../../src/entry-status.ts";
import { formatWorkDate } from "../../src/time.ts";
import appear from "../components/appear.module.css";
import { useTracker } from "./context.tsx";

/**
 * Submitting a day: the person saying their time is done.
 *
 * This is the step that freezes each entry's rate, locks it, and — unless the
 * organisation requires approval — hands it to the accounting system. Nothing
 * else does it and nothing does it automatically, so this card also carries
 * the reminder about earlier days still waiting.
 *
 * Taking a day back is offered whenever it's the person's own submission to
 * withdraw. Once an admin has approved an entry it stays put, and the card
 * says who to ask.
 */
export function SubmitDay() {
  const { model, dispatch, dispatchAll, pending, actingFor, hrefFor } = useTracker();
  const stopped = model.entries.filter((e) => e.status !== "open");
  const unsubmitted = stopped.filter((e) => e.status === "draft");
  const mine = stopped.filter((e) => isOwnerReopenable(e.status, e.adminApproved));
  const approved = stopped.filter((e) => e.adminApproved);
  const running = model.entries.some((e) => e.status === "open");
  const who = actingFor ? actingFor.name : "you";

  // A day with nothing on it has nothing to say — except about other days.
  if (stopped.length === 0 && model.unsubmittedDays.length === 0) return null;

  const submitDay = () => void dispatch("day.submit", { workDate: model.workDate });
  const takeBack = () => void dispatch("day.unsubmit", { workDate: model.workDate });
  const submitEarlier = () =>
    void dispatchAll(model.unsubmittedDays.map((workDate) => ({ type: "day.submit" as const, payload: { workDate } })));

  return (
    <Stack gap="sm">
      {stopped.length > 0 && (
        <Card withBorder padding="md" className={appear.appear}>
          <Stack gap="xs">
            {unsubmitted.length > 0 ? (
              <>
                <Group justify="space-between" wrap="wrap" gap="sm">
                  <Text fw={500}>
                    {unsubmitted.length} {unsubmitted.length === 1 ? "entry" : "entries"} not submitted
                  </Text>
                  <Button onClick={submitDay} loading={pending} disabled={running}>
                    Submit this day
                  </Button>
                </Group>
                <Text size="sm" c="dimmed">
                  {running
                    ? "Stop the timer first — a running timer can't be submitted."
                    : model.requireApproval
                      ? "Submitting locks this time and sends it for approval. You can take it back until an admin approves it."
                      : "Submitting locks this time and sends it to accounting. You can take it back if you need to fix something."}
                </Text>
              </>
            ) : (
              <>
                <Group justify="space-between" wrap="wrap" gap="sm">
                  <Text fw={500}>
                    {approved.length > 0 ? "Approved" : "Submitted"} — {stopped.length}{" "}
                    {stopped.length === 1 ? "entry" : "entries"}
                  </Text>
                  {mine.length > 0 && (
                    <Button variant="default" onClick={takeBack} loading={pending}>
                      Take it back
                    </Button>
                  )}
                </Group>
                <Text size="sm" c="dimmed">
                  {mine.length === 0
                    ? `An admin has approved this day, so it can't be changed here. Ask them to reopen it if ${who === "you" ? "you need" : `${who} needs`} to fix something.`
                    : "This day is done. Take it back to change anything, then submit it again."}
                </Text>
              </>
            )}
          </Stack>
        </Card>
      )}

      {model.unsubmittedDays.length > 0 && (
        <Alert
          color="yellow"
          className={appear.appear}
          title={`${model.unsubmittedDays.length} earlier ${model.unsubmittedDays.length === 1 ? "day" : "days"} not submitted`}
        >
          <Stack gap="xs">
            <Text size="sm">
              {model.unsubmittedDays.slice(0, 5).map((date, i) => (
                <span key={date}>
                  {i > 0 && ", "}
                  <Anchor component={Link} to={hrefFor(date)} size="sm">
                    {formatWorkDate(date)}
                  </Anchor>
                </span>
              ))}
              {model.unsubmittedDays.length > 5 && ` and ${model.unsubmittedDays.length - 5} more`}.
            </Text>
            <Group>
              <Button size="compact-sm" variant="light" color="yellow" onClick={submitEarlier} loading={pending}>
                Submit {model.unsubmittedDays.length === 1 ? "it" : "them all"}
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}
