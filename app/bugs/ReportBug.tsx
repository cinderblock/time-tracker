import { Alert, Button, Collapse, Group, Image, List, Modal, Stack, Text, Textarea, UnstyledButton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useRef, useState } from "react";

import { LIMITS } from "../../src/bug-schema.ts";
import { CODE_BUILD } from "../../src/build-info.ts";
import { draftKey, useDraft } from "../drafts/drafts.ts";
import { addCrumb } from "./breadcrumbs.ts";
import { gatherContext } from "./context.ts";
import { sendReport } from "./report.ts";
import { type Shot, canCapture, captureScreen, drawPage } from "./screenshot.ts";

/**
 * "Report a problem": one button in the app's header, always there.
 *
 * Pressing it first takes the picture and gathers what the app knows —
 * before the dialog covers anything — then asks the person two things in
 * their own words. Everything else is attached for them; the dialog says
 * what, in a list they can open. What they type is kept on the device
 * until it's sent, like every other field in the app.
 */
export function ReportBugButton({ userId }: { userId: number }) {
  const [phase, setPhase] = useState<"idle" | "preparing" | "open" | "capturing" | "sending">("idle");
  const [shots, setShots] = useState<Shot[]>([]);
  const [context, setContext] = useState<Record<string, unknown> | null>(null);
  const [pressedAt, setPressedAt] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [drawFailed, setDrawFailed] = useState<string | null>(null);
  const [showIncluded, setShowIncluded] = useState(false);
  const scope = `u${userId}`;
  const [description, setDescription, discardDescription] = useDraft(draftKey(scope, "bug-report:description"), "");
  const [expected, setExpected, discardExpected] = useDraft(draftKey(scope, "bug-report:expected"), "");
  const narrow = useMediaQuery("(max-width: 36em)");
  // Sent: what was typed goes too, once the dialog has closed.
  const sentRef = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  async function start() {
    if (phase !== "idle") return;
    setPhase("preparing");
    setProblem(null);
    setDrawFailed(null);
    addCrumb("report", "Report a problem pressed");
    const at = Date.now();
    const [shot, gathered] = await Promise.all([
      drawPage().catch((err: unknown) => {
        setDrawFailed(err instanceof Error ? err.message : String(err));
        return null;
      }),
      gatherContext(userId).catch((err: unknown) => ({ gatherFailed: err instanceof Error ? err.message : String(err) })),
    ]);
    setPressedAt(at);
    setShots(shot ? [shot] : []);
    setContext(gathered);
    setPhase("open");
  }

  function forget() {
    for (const s of shots) URL.revokeObjectURL(s.url);
    setShots([]);
    setContext(null);
    setShowIncluded(false);
  }

  function close() {
    // What was typed stays (a draft); the picture and context were of that
    // moment, and are let go once the dialog has finished closing.
    setPhase("idle");
  }

  async function capture() {
    setProblem(null);
    setPhase("capturing");
    // Let the dialog close before the browser asks what to share.
    await new Promise((r) => setTimeout(r, 250));
    try {
      const shot = await captureScreen();
      setShots((list) => [...list.filter((s) => s.kind !== "captured"), shot]);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name !== "NotAllowedError" && name !== "AbortError") {
        setProblem(`Couldn't capture the screen: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setPhase("open");
  }

  function remove(shot: Shot) {
    URL.revokeObjectURL(shot.url);
    setShots((list) => list.filter((s) => s !== shot));
  }

  async function send() {
    if (!description.trim() || !context) return;
    setPhase("sending");
    setProblem(null);
    const result = await sendReport({
      userId,
      pressedAt,
      description,
      expected,
      context: drawFailed ? { ...context, screenshotFailed: drawFailed } : context,
      shots,
    });
    if (result.status === "refused" || result.status === "lost") {
      setProblem(
        result.status === "refused"
          ? `The report wasn't accepted: ${result.error}`
          : "The report couldn't be saved on this device or sent. Try again when you're online.",
      );
      setPhase("open");
      return;
    }
    sentRef.current = true;
    setPhase("idle");
    const stale = result.status === "sent" && result.serverRevision && result.serverRevision !== CODE_BUILD.revision;
    notifications.show({
      color: result.status === "sent" ? "green" : "blue",
      title: result.status === "sent" ? "Thanks — your report was sent" : "Report saved",
      message:
        result.status === "sent"
          ? stale
            ? "A newer version of the app is out; it loads next time the app restarts."
            : "Someone will look into it."
          : "It's kept on this device and will be sent when you're back online.",
      autoClose: 6000,
    });
  }

  const opened = phase === "open" || phase === "sending";

  return (
    <>
      <Button
        size="compact-sm"
        variant="subtle"
        color="gray"
        onClick={() => void start()}
        loading={phase === "preparing"}
        data-bug-exclude
      >
        Report a problem
      </Button>
      <Modal
        opened={opened}
        onClose={close}
        // Emptied only once it's out of sight: clearing it while it fades out
        // looks like the report vanished.
        // (Not when it only stepped aside for a screen capture.)
        onExitTransitionEnd={() => {
          if (phaseRef.current !== "idle") return;
          forget();
          if (sentRef.current) {
            sentRef.current = false;
            discardDescription();
            discardExpected();
          }
        }}
        title="Report a problem"
        fullScreen={narrow}
        size="lg"
        closeOnClickOutside={false}
        data-bug-exclude
      >
        <Stack gap="md">
          <Textarea
            label="What were you trying to do?"
            description="In your own words — a sentence is plenty."
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            maxLength={LIMITS.descriptionLength}
            autosize
            minRows={3}
            data-autofocus
            data-draft
            required
          />
          <Textarea
            label="What happened instead?"
            description="Optional. What did you expect to see?"
            value={expected}
            onChange={(e) => setExpected(e.currentTarget.value)}
            maxLength={LIMITS.descriptionLength}
            autosize
            minRows={2}
            data-draft
          />

          <Stack gap="xs">
            <Text size="sm" fw={500}>
              Screenshots
            </Text>
            {shots.length === 0 && (
              <Text size="sm" c="dimmed">
                {drawFailed ? `The page couldn't be drawn (${drawFailed}).` : "None."}
              </Text>
            )}
            <Group align="flex-start">
              {shots.map((s) => (
                <Stack key={s.url} gap={4} align="flex-start">
                  <Image src={s.url} alt={s.kind === "drawn" ? "The page when you pressed the button" : "Your screen capture"} h={140} w="auto" fit="contain" radius="sm" bd="1px solid var(--mantine-color-default-border)" />
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      {s.kind === "drawn" ? "The page, as the app drew it" : "Your screen"}
                    </Text>
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => remove(s)}>
                      Remove
                    </Button>
                  </Group>
                </Stack>
              ))}
            </Group>
            {canCapture() && (
              <Stack gap={2} align="flex-start">
                <Button size="compact-sm" variant="default" onClick={() => void capture()} disabled={phase === "sending"}>
                  {shots.some((s) => s.kind === "captured") ? "Capture the screen again" : "Capture the real screen"}
                </Button>
                <Text size="xs" c="dimmed">
                  The app's own drawing can be slightly off. This takes an exact picture; your browser asks what to share.
                </Text>
              </Stack>
            )}
          </Stack>

          <Stack gap={4}>
            <UnstyledButton onClick={() => setShowIncluded((v) => !v)} aria-expanded={showIncluded}>
              <Text size="sm" c="blue">
                {showIncluded ? "Hide what's sent with this" : "What's sent with this"}
              </Text>
            </UnstyledButton>
            <Collapse expanded={showIncluded}>
              <List size="sm" spacing={2} c="dimmed">
                <List.Item>The screenshots above</List.Item>
                <List.Item>What this screen was showing — your day, its entries and notes</List.Item>
                <List.Item>What you did in the last few minutes: buttons pressed and pages visited, not what you typed</List.Item>
                <List.Item>Errors on this page, and changes waiting to sync</List.Item>
                <List.Item>Your device, browser and app version</List.Item>
                <List.Item>Other tabs of this app you have open</List.Item>
              </List>
              <Text size="xs" c="dimmed" mt={4}>
                Only admins can read reports.
              </Text>
            </Collapse>
          </Stack>

          {problem && (
            <Alert color="red" role="alert">
              {problem}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button onClick={() => void send()} loading={phase === "sending"} disabled={!description.trim()}>
              Send report
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
