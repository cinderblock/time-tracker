import { Anchor, AppShell, Avatar, Burger, Group, NavLink, Stack, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useEffect } from "react";
import { Form, Link, Outlet, useLocation, useRouteLoaderData } from "react-router";

import { requireUser } from "../auth.server.ts";
import type { loader as rootLoader } from "../root";
import type { Route } from "./+types/_app";

/**
 * Chrome for every signed-in page. The navigation lives in a drawer on phones
 * and a sidebar on wider screens; phase 2 revisits it once there is real
 * tracking UI to organise.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  const { user } = requireUser(context, request);
  return { user: { id: user.id, name: user.name, role: user.role } };
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

  // Close the phone drawer after navigating.
  useEffect(close, [location.pathname, close]);

  const links = [
    { to: "/", label: "Track time" },
    { to: "/account", label: "Your account" },
    ...(user.role === "admin"
      ? [
          { to: "/admin/jobs", label: "Jobs" },
          { to: "/admin/people", label: "People" },
        ]
      : []),
  ];

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
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <Stack gap={4} justify="space-between" h="100%">
          <Stack gap={4}>
            {links.map((link) => (
              <NavLink
                key={link.to}
                component={Link}
                to={link.to}
                label={link.label}
                active={
                  link.to === "/"
                    ? location.pathname === "/" || location.pathname.startsWith("/day/")
                    : location.pathname.startsWith(link.to)
                }
              />
            ))}
          </Stack>
          <Form method="post" action="/signout">
            <NavLink component="button" type="submit" label="Sign out" c="dimmed" />
          </Form>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
