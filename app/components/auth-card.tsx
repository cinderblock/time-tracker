import { Card, Center, Stack, Text, Title } from "@mantine/core";
import { useRouteLoaderData } from "react-router";

import type { loader as rootLoader } from "../root";

/** The centred card that frames every signed-out page. */
export function AuthCard({ heading, children }: { heading: string; children: React.ReactNode }) {
  const root = useRouteLoaderData<typeof rootLoader>("root");
  return (
    <Center mih="100dvh" p="md">
      <Card withBorder shadow="sm" padding="xl" radius="md" w="100%" maw={440}>
        <Stack gap="lg">
          <Stack gap={2}>
            <Text c="dimmed" size="sm" fw={600} tt="uppercase">
              {root?.branding.name}
            </Text>
            <Title order={2}>{heading}</Title>
          </Stack>
          {children}
        </Stack>
      </Card>
    </Center>
  );
}
