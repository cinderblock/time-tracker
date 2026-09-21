import { Anchor, Badge, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useState } from "react";
import { Link, useRevalidator, useSubmit } from "react-router";

import type { Op } from "../../src/ops-schema.ts";
import { getEngine, useSyncStatus } from "./client.ts";
import { clearSnapshots, shellCopy } from "./storage.ts";

/**
 * How the outbox is doing, in words, in the header. Silent when everything is
 * saved; otherwise says what's waiting and why.
 */
export function SyncStatusBadge() {
  const status = useSyncStatus();
  const n = status.pending;
  // Short enough to fit beside the app name on a phone.
  const badge = { variant: "light", size: "lg", radius: "sm", tt: "none", fw: 600 } as const;

  if (status.signedOut) {
    return (
      <Anchor component={Link} to="/signin?next=%2F" size="sm" c="red" fw={600}>
        Sign in to sync {n}
      </Anchor>
    );
  }
  if (status.offline) {
    return (
      <Badge color="yellow" {...badge}>
        {n > 0 ? `Offline · ${n} to sync` : "Offline"}
      </Badge>
    );
  }
  if (n > 0) {
    return (
      <Badge color="blue" {...badge}>
        {status.syncing ? `Syncing ${n}…` : `${n} to sync`}
      </Badge>
    );
  }
  return null;
}

/** What a queued op was, in words, for a "couldn't save" message. */
function describe(op: Op): string {
  switch (op.type) {
    case "timer.start":
      return "Starting a timer";
    case "timer.pause":
      return "Pausing a timer";
    case "timer.resume":
      return "Resuming a timer";
    case "timer.stop":
      return "Stopping a timer";
    case "entry.create":
      return "Adding time";
    case "entry.update":
      return "Changing an entry";
    case "entry.delete":
      return "Deleting an entry";
    case "entry.restore":
      return "Undoing a delete";
    case "note.create":
      return "Adding a note";
    case "note.update":
      return "Changing a note";
    case "note.delete":
    case "note.restore":
      return "Deleting a note";
    case "rollup.commit":
      return "Turning notes into time";
    case "day.submit":
      return "Submitting a day";
    case "day.unsubmit":
      return "Taking a day back";
    case "job.create":
      return "Creating a job";
  }
}

/**
 * Starts syncing for the signed-in person and keeps the screen in step:
 * refreshes after changes are confirmed, and reports changes the server
 * refused that nobody was waiting on (typically ones made offline).
 */
export function useSyncLifecycle(user: { id: number; name: string; role: "admin" | "employee" }) {
  const revalidator = useRevalidator();
  // The engine's listeners outlive renders; reach the current revalidate through a ref.
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;

  useEffect(() => {
    shellCopy.write({ userId: user.id, name: user.name, role: user.role });
    void navigator.storage?.persist?.().catch(() => {});
    const engine = getEngine();
    if (!engine) return;
    void engine.start(user.id);

    const offSynced = engine.onSynced(() => void revalidate.current());
    const offRejected = engine.onRejected(({ op, result, handled }) => {
      if (handled) return;
      notifications.show({
        color: "red",
        title: `${describe(op)} couldn't be saved`,
        message: result.error,
        autoClose: false,
      });
    });
    return () => {
      offSynced();
      offRejected();
    };
  }, [user.id, user.name, user.role]);
}

/**
 * Sign out, warning first if this device still holds unsaved changes. They
 * stay on the device and sync the next time the same person signs in here.
 * The device's copies of that person's days are cleared either way.
 */
export function SignOutButton({ userId, children }: { userId: number; children: (open: () => void) => React.ReactNode }) {
  const status = useSyncStatus();
  const submit = useSubmit();
  const [warning, setWarning] = useState(false);

  async function signOut() {
    setWarning(false);
    getEngine()?.stop();
    shellCopy.clear();
    await clearSnapshots(userId).catch(() => {});
    // Pages the service worker kept for offline use hold this person's data.
    await globalThis.caches?.delete("tt-pages").catch(() => {});
    submit(null, { method: "post", action: "/signout" });
  }

  const n = status.pending;
  return (
    <>
      {children(() => (n > 0 ? setWarning(true) : void signOut()))}
      <Modal opened={warning} onClose={() => setWarning(false)} title="Changes not saved yet" centered>
        <Stack>
          <Text>
            {n} change{n === 1 ? " hasn't" : "s haven't"} reached the server yet. If you sign out now, they stay on
            this device and are saved the next time you sign in here.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setWarning(false)}>
              Stay signed in
            </Button>
            <Button color="red" onClick={() => void signOut()}>
              Sign out anyway
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

