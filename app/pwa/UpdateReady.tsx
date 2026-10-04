import { Button, Group, Paper, Text } from "@mantine/core";
import { useEffect, useState } from "react";

import { loadUpdateNow, onUpdateWaiting } from "./auto-update.ts";

/**
 * A new version arrived while someone was typing, or with a form not yet
 * saved; it loads at the next moment that loses nothing (auto-update.ts).
 * Until then this says so, and offers to load it now.
 */
export function UpdateReady() {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => onUpdateWaiting(setWaiting), []);
  if (!waiting) return null;
  return (
    <Paper
      role="status"
      withBorder
      shadow="md"
      p="xs"
      style={{ position: "fixed", right: 12, bottom: 12, zIndex: 300, maxWidth: "calc(100vw - 24px)" }}
    >
      <Group gap="sm" wrap="nowrap">
        <Text size="sm">A new version is ready. It loads once you've finished typing; your notes are kept.</Text>
        <Button size="compact-sm" variant="light" onClick={loadUpdateNow}>
          Load it now
        </Button>
      </Group>
    </Paper>
  );
}
