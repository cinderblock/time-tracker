import {
  Alert,
  Badge,
  Button,
  Card,
  Chip,
  Divider,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { TimeInput } from "@mantine/dates";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { type NotificationPrefs, REPEAT_MAX_TIMES } from "../../src/notifications/prefs-schema.ts";
import { formatClock, formatWorkDate, workDateOf } from "../../src/time.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import type { DeviceView, NotificationsView } from "../notifications.server.ts";
import {
  PushError,
  type PushSupport,
  currentSubscription,
  notificationPermission,
  pushSupport,
  subscribe,
  unsubscribe,
} from "../pwa/push-client.ts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function when(instant: number, timeZone: string): string {
  return `${formatWorkDate(workDateOf(instant, timeZone))}, ${formatClock(instant, timeZone)}`;
}

/** The account page's Notifications section. */
export function NotificationSettings({ view, isAdmin }: { view: NotificationsView; isAdmin: boolean }) {
  return (
    <Stack gap="sm" id="notifications">
      <Title order={3}>Notifications</Title>
      <Text size="sm" c="dimmed">
        Reminders at the end of your day, and alerts when something needs you. Pick which, and when, below; then turn
        them on for each device you want them on.
      </Text>
      {!view.available && (
        <Alert color="yellow">
          This server isn't set up to send notifications yet — an admin needs to add its VAPID keys. Your choices below
          are kept for when it is.
        </Alert>
      )}
      {view.available && view.vapidPublicKey && <ThisDevice devices={view.devices} vapidPublicKey={view.vapidPublicKey} />}
      {view.devices.length > 0 && <Devices devices={view.devices} timeZone={view.timeZone} available={view.available} />}
      <DayOff on={view.dayOffToday} />
      <PrefsForm prefs={view.prefs} isAdmin={isAdmin} timeZone={view.timeZone} weekStartsOn={view.weekStartsOn} />
      {view.recent.length > 0 && <Recent recent={view.recent} timeZone={view.timeZone} />}
    </Stack>
  );
}

function supportMessage(support: PushSupport): string | null {
  switch (support.kind) {
    case "ready":
      return null;
    case "ios-needs-install":
      return "On iPhone and iPad, notifications only work in the app on your Home Screen (iOS 16.4 or later). In Safari, tap Share → Add to Home Screen, open Time Tracker from there, and turn them on here.";
    case "unsupported":
      return "This browser can't receive notifications.";
    case "denied":
      return "Notifications are blocked for this site in this browser. Allow them in the site's settings (the icon to the left of the address), then reload this page.";
    case "no-worker":
      return "The app's background helper isn't running in this window. Reload the page and try again.";
  }
}

/** This browser: on or off, and the button that changes it. */
function ThisDevice({ devices, vapidPublicKey }: { devices: DeviceView[]; vapidPublicKey: string }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  const relink = useFetcher();
  const [support, setSupport] = useState<PushSupport | null>(null);
  // undefined: not looked yet; null: this browser has no subscription.
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const relinked = useRef(false);

  useEffect(() => {
    void pushSupport().then(setSupport);
    void currentSubscription().then((s) => setEndpoint(s?.endpoint ?? null));
  }, []);

  const mine = endpoint ? devices.find((d) => d.endpoint === endpoint) : undefined;

  // Signed out and back in on this device: the browser still has its
  // subscription, but the server tied it to the old session. Tie it to this
  // one — it is the same person's, so nothing they didn't choose is turned on.
  useEffect(() => {
    if (relinked.current || !mine || mine.live || support?.kind !== "ready") return;
    relinked.current = true;
    void (async () => {
      if ((await notificationPermission()) !== "granted") return;
      const s = await currentSubscription();
      if (s) relink.submit({ intent: "push-subscribe", subscription: JSON.stringify(s.toJSON()) }, { method: "post" });
    })();
  }, [mine, support, relink]);

  async function turnOn() {
    setBusy(true);
    setProblem(null);
    try {
      const json = await subscribe(vapidPublicKey);
      setEndpoint(json.endpoint ?? null);
      fetcher.submit({ intent: "push-subscribe", subscription: JSON.stringify(json) }, { method: "post" });
    } catch (err) {
      setProblem(err instanceof PushError ? err.message : "The browser wouldn't set up notifications. Try again.");
      void pushSupport().then(setSupport);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      const gone = (await unsubscribe()) ?? mine?.endpoint ?? "";
      setEndpoint(null);
      fetcher.submit({ intent: "push-forget", endpoint: gone }, { method: "post" });
    } finally {
      setBusy(false);
    }
  }

  if (!support || endpoint === undefined) return null;
  const message = supportMessage(support);
  const on = Boolean(mine);

  return (
    <Card withBorder data-testid="this-device">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={500}>This device</Text>
          <Badge color={on ? "green" : "gray"} variant="light">
            {on ? "On" : "Off"}
          </Badge>
        </Group>
        {message ? (
          <Text size="sm" c="dimmed">
            {message}
          </Text>
        ) : (
          <Group gap="xs">
            {on ? (
              <>
                <Button
                  variant="light"
                  loading={fetcher.state !== "idle"}
                  onClick={() => fetcher.submit({ intent: "push-test", deviceId: String(mine!.id) }, { method: "post" })}
                >
                  Send a test
                </Button>
                <Button variant="default" onClick={() => void turnOff()} loading={busy}>
                  Turn off here
                </Button>
              </>
            ) : (
              <Button onClick={() => void turnOn()} loading={busy || fetcher.state !== "idle"}>
                Turn on notifications here
              </Button>
            )}
          </Group>
        )}
        {problem && (
          <Alert color="yellow" role="alert">
            {problem}
          </Alert>
        )}
      </Stack>
    </Card>
  );
}

function Devices({ devices, timeZone, available }: { devices: DeviceView[]; timeZone: string; available: boolean }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  return (
    <Card withBorder>
      <Stack gap="xs">
        <Text fw={500}>Devices that get them</Text>
        {devices.map((d) => (
          <Group key={d.id} justify="space-between" wrap="nowrap" align="start" data-testid="push-device">
            <Stack gap={0}>
              <Text size="sm">
                {d.label}
                {!d.live && (
                  <Text span size="sm" c="dimmed">
                    {" "}
                    — signed out, gets nothing
                  </Text>
                )}
              </Text>
              <Text size="xs" c="dimmed">
                Added {when(d.createdAt, timeZone)}
                {d.lastSentAt ? ` · last sent ${when(d.lastSentAt, timeZone)}` : ""}
              </Text>
              {d.lastError && (
                <Text size="xs" c="red">
                  Last try failed ({d.failures}×): {d.lastError}
                </Text>
              )}
            </Stack>
            <Group gap={4} wrap="nowrap">
              {available && d.live && (
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() => fetcher.submit({ intent: "push-test", deviceId: String(d.id) }, { method: "post" })}
                >
                  Test
                </Button>
              )}
              <Button
                size="xs"
                variant="subtle"
                color="red"
                onClick={() => fetcher.submit({ intent: "push-remove", deviceId: String(d.id) }, { method: "post" })}
              >
                Remove
              </Button>
            </Group>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

function DayOff({ on }: { on: boolean }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  const [value, setValue] = useState(on);
  useEffect(() => setValue(on), [on]);
  return (
    <Card withBorder>
      <Switch
        label="Today is a day off"
        description="No end-of-day reminders today. Alerts about held or refused time still come."
        checked={value}
        disabled={fetcher.state !== "idle"}
        onChange={(e) => {
          const next = e.currentTarget.checked;
          setValue(next);
          fetcher.submit({ intent: "day-off", off: next ? "1" : "0" }, { method: "post" });
        }}
      />
    </Card>
  );
}

const REPEAT_OPTIONS = [
  { value: "0", label: "Once" },
  { value: "15", label: "Every 15 minutes" },
  { value: "30", label: "Every 30 minutes" },
  { value: "60", label: "Every hour" },
  { value: "120", label: "Every 2 hours" },
];

function PrefsForm({
  prefs,
  isAdmin,
  timeZone,
  weekStartsOn,
}: {
  prefs: NotificationPrefs;
  isAdmin: boolean;
  timeZone: string;
  weekStartsOn: number;
}) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  const [p, setP] = useState(prefs);
  useEffect(() => setP(prefs), [prefs]);
  const dirty = JSON.stringify(p) !== JSON.stringify(prefs);

  /** Change one group of settings. */
  const set = <K extends keyof NotificationPrefs>(key: K, value: Partial<NotificationPrefs[K]> | NotificationPrefs[K]) =>
    setP((prev) => ({
      ...prev,
      [key]:
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? { ...(prev[key] as object), ...value }
          : value,
    }));

  const order = Array.from({ length: 7 }, (_, i) => (weekStartsOn + i) % 7);

  return (
    <Card withBorder>
      <Stack gap="md">
        <Stack gap={6}>
          <Text fw={500}>Your workdays</Text>
          <Chip.Group
            multiple
            value={p.workdays.map(String)}
            onChange={(v) => set("workdays", v.map(Number).sort((a, b) => a - b))}
          >
            <Group gap={6}>
              {order.map((d) => (
                <Chip key={d} value={String(d)} size="sm">
                  {WEEKDAYS[d]}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <TimeInput
            label="End-of-day reminders at"
            description={`Times are ${timeZone} time.`}
            value={p.reminderAt}
            onChange={(e) => set("reminderAt", e.currentTarget.value)}
            maw={220}
          />
        </Stack>

        <Divider label="At the end of the day" labelPosition="left" />
        <Stack gap="sm">
          <Switch
            label="If I haven't entered my time"
            checked={p.dayEmpty.on}
            onChange={(e) => set("dayEmpty", { on: e.currentTarget.checked })}
          />
          <NumberInput
            label="…or less than this many hours"
            description="0: only when nothing at all is entered."
            value={p.dayEmpty.minHours}
            onChange={(v) => set("dayEmpty", { minHours: typeof v === "number" ? v : 0 })}
            min={0}
            max={24}
            step={0.5}
            decimalScale={2}
            disabled={!p.dayEmpty.on}
            maw={280}
            ml="xl"
          />
          <Switch
            label="If today's notes aren't turned into hours yet"
            description="When you track with notes."
            checked={p.notesPending.on}
            onChange={(e) => set("notesPending", { on: e.currentTarget.checked })}
          />
          <Group gap="sm" ml="xl" align="end">
            <Switch
              label="Also in the morning, if an earlier day still has notes, at"
              checked={p.notesPending.morning}
              disabled={!p.notesPending.on}
              onChange={(e) => set("notesPending", { morning: e.currentTarget.checked })}
            />
            <TimeInput
              aria-label="Morning reminder time"
              value={p.notesPending.morningAt}
              disabled={!p.notesPending.on || !p.notesPending.morning}
              onChange={(e) => set("notesPending", { morningAt: e.currentTarget.value })}
              w={120}
            />
          </Group>
          <Switch
            label="If a timer is still running or paused"
            checked={p.timerRunning.atReminder}
            onChange={(e) => set("timerRunning", { atReminder: e.currentTarget.checked })}
          />
          <Group gap="sm" align="end">
            <Select
              label="Days with time not submitted"
              data={[
                { value: "off", label: "Don't remind me" },
                { value: "daily", label: "Every workday, about earlier days" },
                { value: "weekly", label: "Once a week, about the week" },
              ]}
              value={p.unsubmitted.when}
              onChange={(v) => v && set("unsubmitted", { when: v as NotificationPrefs["unsubmitted"]["when"] })}
              allowDeselect={false}
              w={280}
            />
            {p.unsubmitted.when === "weekly" && (
              <Select
                aria-label="Weekly reminder day"
                data={order.map((d) => ({ value: String(d), label: `on ${WEEKDAY_NAMES[d]}` }))}
                value={String(p.unsubmitted.weeklyOn)}
                onChange={(v) => v && set("unsubmitted", { weeklyOn: Number(v) })}
                allowDeselect={false}
                w={170}
              />
            )}
          </Group>
        </Stack>

        <Divider label="As they happen" labelPosition="left" />
        <Stack gap="sm">
          <Switch
            label="When QuickBooks already has time on a day I submitted"
            checked={p.timeHeld.on}
            onChange={(e) => set("timeHeld", { on: e.currentTarget.checked })}
          />
          <Switch
            label="When QuickBooks refuses my time"
            checked={p.sendFailed.on}
            onChange={(e) => set("sendFailed", { on: e.currentTarget.checked })}
          />
          <Group gap="sm" align="end">
            <Switch
              label="When a timer has run longer than (hours)"
              checked={p.timerRunning.long}
              onChange={(e) => set("timerRunning", { long: e.currentTarget.checked })}
            />
            <NumberInput
              aria-label="Long timer hours"
              value={p.timerRunning.longHours}
              onChange={(v) => set("timerRunning", { longHours: typeof v === "number" ? v : 10 })}
              min={1}
              max={24}
              step={1}
              disabled={!p.timerRunning.long}
              w={90}
            />
          </Group>
          {isAdmin && (
            <Group gap="sm" align="center">
              <Switch
                label="When anyone's time needs an admin"
                checked={p.adminAttention.on}
                onChange={(e) => set("adminAttention", { on: e.currentTarget.checked })}
              />
              <SegmentedControl
                size="xs"
                data={[
                  { value: "immediately", label: "As it happens" },
                  { value: "daily", label: "Once a day" },
                ]}
                value={p.adminAttention.when}
                disabled={!p.adminAttention.on}
                onChange={(v) => set("adminAttention", { when: v as NotificationPrefs["adminAttention"]["when"] })}
              />
            </Group>
          )}
          <Group gap="sm" align="end">
            <Switch
              label="Only on workdays, between"
              checked={p.quietHours.on}
              onChange={(e) => set("quietHours", { on: e.currentTarget.checked })}
            />
            <TimeInput
              aria-label="Alerts from"
              value={p.quietHours.from}
              disabled={!p.quietHours.on}
              onChange={(e) => set("quietHours", { from: e.currentTarget.value })}
              w={120}
            />
            <Text size="sm">and</Text>
            <TimeInput
              aria-label="Alerts until"
              value={p.quietHours.until}
              disabled={!p.quietHours.on}
              onChange={(e) => set("quietHours", { until: e.currentTarget.value })}
              w={120}
            />
          </Group>
          <Text size="xs" c="dimmed">
            Outside that window, alerts wait and come at the start of the next one.
          </Text>
        </Stack>

        <Divider label="Repeats and pauses" labelPosition="left" />
        <Stack gap="sm">
          <Group gap="sm" align="end">
            <Select
              label="End-of-day reminders"
              description="Sent again while they still apply."
              data={REPEAT_OPTIONS}
              value={String(p.repeat.everyMinutes)}
              onChange={(v) =>
                v && set("repeat", { everyMinutes: Number(v) as NotificationPrefs["repeat"]["everyMinutes"] })
              }
              allowDeselect={false}
              w={220}
            />
            <NumberInput
              label="At most"
              suffix=" times"
              value={p.repeat.maxTimes}
              onChange={(v) => set("repeat", { maxTimes: typeof v === "number" ? v : 3 })}
              min={1}
              max={REPEAT_MAX_TIMES}
              disabled={p.repeat.everyMinutes === 0}
              w={120}
            />
          </Group>
          <Group gap="sm" align="end">
            <TextInput
              type="date"
              label="Pause everything through"
              description="For time off: nothing is sent until the day after."
              value={p.pausedThrough ?? ""}
              onChange={(e) => set("pausedThrough", e.currentTarget.value || null)}
              w={220}
            />
            {p.pausedThrough && (
              <Button variant="subtle" onClick={() => set("pausedThrough", null)}>
                Clear
              </Button>
            )}
          </Group>
        </Stack>

        <Group gap="xs">
          <Button
            disabled={!dirty}
            loading={fetcher.state !== "idle"}
            onClick={() => fetcher.submit({ intent: "notification-prefs", prefs: JSON.stringify(p) }, { method: "post" })}
          >
            Save notification settings
          </Button>
          {dirty && (
            <Button variant="default" onClick={() => setP(prefs)}>
              Undo changes
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

function Recent({ recent, timeZone }: { recent: NotificationsView["recent"]; timeZone: string }) {
  return (
    <Card withBorder>
      <Stack gap="xs">
        <Text fw={500}>Recently sent</Text>
        {recent.map((n) => (
          <Stack key={n.id} gap={0} data-testid="recent-notification">
            <Text size="sm">{n.title}</Text>
            <Text size="xs" c="dimmed">
              {when(n.lastAt, timeZone)}
              {n.sentCount > 1 ? ` · sent ${n.sentCount} times` : ""}
              {n.delivered === 0 ? " · no device took it" : ` · to ${n.delivered} device${n.delivered === 1 ? "" : "s"}`}
              {n.snoozedUntil && n.snoozedUntil > n.lastAt ? ` · snoozed until ${formatClock(n.snoozedUntil, timeZone)}` : ""}
            </Text>
          </Stack>
        ))}
      </Stack>
    </Card>
  );
}
