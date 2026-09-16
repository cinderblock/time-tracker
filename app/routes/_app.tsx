import { Anchor, AppShell, Avatar, Burger, Divider, Group, NavLink, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useEffect } from "react";
import { Link, Outlet, useLocation, useRouteLoaderData } from "react-router";

import { requireUser } from "../auth.server.ts";
import { isOfflineError } from "../offline/loaders.ts";
import { shellCopy } from "../offline/storage.ts";
import { SignOutButton, SyncStatusBadge, useSyncLifecycle } from "../offline/SyncStatusBadge.tsx";
import type { loader as rootLoader } from "../root";
import type { Route } from "./+types/_app";

/**
 * Chrome for every signed-in page: navigation (a drawer on phones, a sidebar
 * on wider screens), who's signed in, and whether changes are waiting to sync.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  const { user } = requireUser(context, request);
  return { user: { id: user.id, name: user.name, role: user.role } };
}

/**
 * Offline, whoever was last signed in on this device is shown. Only their own
 * copies are on the device, and nothing is sent until the server has checked
 * the session again.
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  try {
    return await serverLoader();
  } catch (err) {
    const shell = isOfflineError(err) ? shellCopy.read() : null;
    if (shell) return { user: { id: shell.userId, name: shell.name, role: shell.role } };
    throw err;
  }
}

const initials = (name: string) =>
  name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;
  const root = useRouteLoaderData<typeof rootLoader>("root");
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  useSyncLifecycle(user);

  // Close the phone drawer after navigating.
  useEffect(close, [location.pathname, close]);

  const links = [
    { to: "/", label: "Track time" },
    { to: "/account", label: "Your account" },
  ];
  const adminLinks =
    user.role === "admin"
      ? [
          { to: "/admin/timesheets", label: "Timesheets" },
          { to: "/admin/calendar", label: "Calendar" },
          { to: "/admin/reports", label: "Reports" },
          { to: "/admin/people", label: "People" },
          { to: "/admin/jobs", label: "Jobs" },
          { to: "/admin/rates", label: "Rates & categories" },
        ]
      : [];
  const isActive = (to: string) =>
    to === "/"
      ? location.pathname === "/" || location.pathname.startsWith("/day/")
      : location.pathname === to || location.pathname.startsWith(`${to}/`);
  const renderLink = (link: { to: string; label: string }) => (
    <NavLink key={link.to} component={Link} to={link.to} label={link.label} active={isActive(link.to)} />
  );

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 240, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            <Anchor component={Link} to="/" fw={700} size="lg" c="bright" underline="never" truncate>
              {root?.branding.name}
            </Anchor>
          </Group>
          <Group gap="sm" wrap="nowrap">
          <SyncStatusBadge />
          <UnstyledButton component={Link} to="/account" aria-label="Your account">
            <Group gap="xs" wrap="nowrap">
              <Text size="sm" visibleFrom="xs" truncate>
                {user.name}
              </Text>
              <Avatar color="brand" radius="xl" size="md">
                {initials(user.name)}
              </Avatar>
            </Group>
          </UnstyledButton>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppShell.Section grow component={ScrollArea}>
          <Stack gap={4}>
            {links.map(renderLink)}
            {adminLinks.length > 0 && (
              <>
                <Divider my="xs" label="Admin" labelPosition="left" />
                {adminLinks.map(renderLink)}
              </>
            )}
          </Stack>
        </AppShell.Section>
        <AppShell.Section>
          <SignOutButton userId={user.id}>
            {(signOut) => <NavLink component="button" type="button" label="Sign out" c="dimmed" onClick={signOut} />}
          </SignOutButton>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
