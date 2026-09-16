import { Alert, Badge, Card, Group, Stack, Text, Title } from "@mantine/core";

import { accountingBackend } from "../../src/accounting/index.ts";
import { BackendUnavailableError } from "../../src/accounting/types.ts";
import { config } from "../../src/config.server.ts";
import { requireUser } from "../auth.server.ts";
import type { Route } from "./+types/_app._index";

/**
 * Home. A placeholder until phase 2 puts the timer and today's entries here.
 * Admins additionally see whether the accounting backend is reachable.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { user } = requireUser(context, request);

  let backend: { kind: string; ok: boolean; detail: string } | null = null;
  if (user.role === "admin") {
    try {
      const b = accountingBackend();
      backend = { kind: b.kind, ...(await b.health()) };
    } catch (err) {
      // A selected-but-unimplemented backend throws on construction by design
      // (src/accounting/index.ts). Report it rather than failing the page.
      backend = {
        kind: config.accounting.kind,
        ok: false,
        detail: err instanceof BackendUnavailableError ? err.message : String(err),
      };
    }
  }

  return { firstName: user.name.split(" ")[0] ?? user.name, backend, timezone: config.timezone };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { firstName, backend, timezone } = loaderData;

  return (
    <Stack gap="lg" maw={640}>
      <Title order={2}>Hi, {firstName}</Title>

      <Alert color="blue" title="Time tracking is on its way">
        You're signed in. Timers, notes and manual entries arrive in the next phase.
      </Alert>

      {backend && (
        <Card withBorder padding="md">
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={500}>Accounting backend</Text>
              <Badge color={backend.ok ? "green" : "yellow"}>{backend.kind}</Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {backend.detail}
            </Text>
            <Text size="sm" c="dimmed">
              Work days are counted in {timezone}.
            </Text>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
