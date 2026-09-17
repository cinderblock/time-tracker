import { Badge, Button, Card, ColorInput, Group, Select, SimpleGrid, Stack, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import { branding, brandingDefaults, setBranding } from "../../src/branding.ts";
import { BRANDING_LIMITS } from "../../src/limits.ts";
import { setWeekStartsOn, weekStartsOn } from "../../src/settings.ts";
import { UserInputError } from "../../src/users.ts";
import { handleForm, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.admin.settings";

/**
 * Organisation settings: what the app is called and its colour, and the day
 * weeks start on.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Mantine's own colours, as quick picks. */
const SWATCHES = ["#1c7ed6", "#0ca678", "#37b24d", "#f59f00", "#e8590c", "#e03131", "#c2255c", "#7048e8", "#4263eb", "#1098ad", "#495057"];

export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  return { branding: branding(), defaults: brandingDefaults(), weekStartsOn: weekStartsOn() };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Settings");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user } = requireAdmin(context, request);
  return handleForm(request, {
    branding: (form) => {
      setBranding(
        { name: stringField(form, "name"), shortName: stringField(form, "shortName"), themeColor: stringField(form, "themeColor") },
        user.id,
      );
      return { ok: true, message: "Saved. Phones pick up the new name and colour the next time the app opens." };
    },
    "week-start": (form) => {
      const day = Number(stringField(form, "day"));
      if (!Number.isInteger(day) || day < 0 || day > 6) throw new UserInputError("Pick a day.");
      setWeekStartsOn(day, user.id);
      return { ok: true, message: `Weeks now start on ${WEEKDAYS[day]}.` };
    },
  });
}

type Data = Route.ComponentProps["loaderData"];

export default function Settings({ loaderData }: Route.ComponentProps) {
  return (
    <Stack gap="xl" maw={760}>
      <Title order={2}>Settings</Title>
      <BrandingCard data={loaderData} />
      <WeekStartCard weekStartsOn={loaderData.weekStartsOn} />
    </Stack>
  );
}

function BrandingCard({ data }: { data: Data }) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const [name, setName] = useState(data.branding.name);
  const [shortName, setShortName] = useState(data.branding.shortName);
  const [color, setColor] = useState(data.branding.themeColor);
  // Follow the saved values after a save (or a reset to the defaults).
  useEffect(() => {
    setName(data.branding.name);
    setShortName(data.branding.shortName);
    setColor(data.branding.themeColor);
  }, [data.branding.name, data.branding.shortName, data.branding.themeColor]);

  const valid = /^#[0-9a-f]{6}$/i.test(color);
  const busy = fetcher.state !== "idle";
  const save = (values: { name: string; shortName: string; themeColor: string }) =>
    fetcher.submit({ intent: "branding", ...values }, { method: "post" });

  return (
    <Stack gap="sm">
      <Title order={3}>Name and colour</Title>
      <Text size="sm" c="dimmed">
        Shown in the header, the browser tab, sign-in prompts and on phones' home screens. A phone that already has the
        app installed may keep the old name under its icon until the app is added again.
      </Text>
      <Card withBorder>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save({ name, shortName, themeColor: color });
          }}
        >
          <Stack gap="sm">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <TextInput
                label="Name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                maxLength={BRANDING_LIMITS.name}
                required
              />
              <TextInput
                label="Short name"
                description="Under the home-screen icon"
                value={shortName}
                onChange={(e) => setShortName(e.currentTarget.value)}
                maxLength={BRANDING_LIMITS.shortName}
                required
              />
            </SimpleGrid>
            <ColorInput
              label="Colour"
              value={color}
              onChange={setColor}
              format="hex"
              swatches={SWATCHES}
              swatchesPerRow={11}
              // Beside the field where there's room, so it doesn't cover Save.
              popoverProps={{ position: "right-start" }}
              error={valid ? undefined : "Pick a colour, like #1c7ed6."}
              maw={320}
            />
            <Group gap="sm" align="center">
              <Text size="sm" c="dimmed">
                Preview:
              </Text>
              <Badge size="lg" color={valid ? color : "gray"} autoContrast>
                {name || data.defaults.name}
              </Badge>
              <Button size="compact-sm" color={valid ? color : "gray"} autoContrast>
                Start
              </Button>
            </Group>
            <Group gap="sm">
              <Button type="submit" loading={busy} disabled={!valid || !name.trim() || !shortName.trim()}>
                Save
              </Button>
              <Button
                variant="subtle"
                disabled={busy}
                onClick={() => save({ name: "", shortName: "", themeColor: "" })}
              >
                Use the defaults ({data.defaults.name}, {data.defaults.themeColor})
              </Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}

function WeekStartCard({ weekStartsOn }: { weekStartsOn: number }) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  return (
    <Stack gap="sm">
      <Title order={3}>Weeks</Title>
      <Card withBorder>
        <Select
          label="Weeks start on"
          description="Timesheets, the calendar and everyone's week strip use this. Match your payroll week."
          data={WEEKDAYS.map((label, value) => ({ value: String(value), label }))}
          value={String(weekStartsOn)}
          allowDeselect={false}
          disabled={fetcher.state !== "idle"}
          onChange={(v) => v != null && fetcher.submit({ intent: "week-start", day: v }, { method: "post" })}
          maw={260}
        />
      </Card>
    </Stack>
  );
}
