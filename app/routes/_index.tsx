import { Alert, Badge, Card, Container, Group, Stack, Text, Title } from "@mantine/core";

import type { Route } from "./+types/_index";
import { accountingBackend } from "../../src/accounting/index.ts";
import { config } from "../../src/config.ts";
import { db } from "../../src/db.ts";
import { BackendUnavailableError } from "../../src/accounting/types.ts";

/**
 * Placeholder home screen for phase 0.
 *
 * It exists to prove the whole spine is wired — config, SQLite + migrations,
 * and the accounting seam — and it will be replaced by the tracking UI in
 * phase 2. Keeping it honest about what is and isn't set up is more useful
 * than a "Hello world".
 */
export async function loader() {
  const userCount = db()
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users")
    .get()!.n;

  let backend: { kind: string; ok: boolean; detail: string };
  try {
    const b = accountingBackend();
    const health = await b.health();
    backend = { kind: b.kind, ...health };
  } catch (err) {
    // A backend selected but not yet implemented throws on construction. That
    // is deliberate (see src/accounting/index.ts) — report it, don't crash the
    // page.
    backend = {
      kind: config.accounting.kind,
      ok: false,
      detail: err instanceof BackendUnavailableError ? err.message : String(err),
    };
  }

  return {
    appName: config.branding.name,
    timezone: config.timezone,
    needsSetup: userCount === 0,
    backend,
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { appName, timezone, needsSetup, backend } = loaderData;

  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <Title order={1}>{appName}</Title>

        {needsSetup && (
          <Alert color="blue" title="Not set up yet">
            No users exist yet. First-run setup — which creates the initial admin
            and registers their passkey — arrives in phase 1.
          </Alert>
        )}

        <Card withBorder padding="md">
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={500}>Database</Text>
              <Badge color="green">migrated</Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {userCountLabel(needsSetup)} · work days are computed in {timezone}
            </Text>
          </Stack>
        </Card>

        <Card withBorder padding="md">
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={500}>Accounting backend</Text>
              <Badge color={backend.ok ? "green" : "yellow"}>{backend.kind}</Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {backend.detail}
            </Text>
          </Stack>
        </Card>
      </Stack>
    </Container>
  );
}

function userCountLabel(needsSetup: boolean): string {
  return needsSetup ? "No users yet" : "Users present";
}
