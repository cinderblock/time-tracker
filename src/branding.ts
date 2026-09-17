import { config } from "./config.server.ts";
import { BRANDING_LIMITS } from "./limits.ts";
import { readSetting, writeSetting } from "./settings.ts";
import { UserInputError } from "./users.ts";

/**
 * What the organisation calls the app, and its colour. Admins set these on
 * the Settings page; until they do, the deployment's APP_NAME, APP_SHORT_NAME
 * and APP_THEME_COLOR (or the generic defaults) apply.
 */

export interface Branding {
  name: string;
  /** Under the home-screen icon. */
  shortName: string;
  /** "#rrggbb" */
  themeColor: string;
}

const KEYS = { name: "branding_name", shortName: "branding_short_name", themeColor: "branding_theme_color" } as const;

export function branding(): Branding {
  return {
    name: readSetting(KEYS.name) || config.branding.name,
    shortName: readSetting(KEYS.shortName) || config.branding.shortName,
    themeColor: readSetting(KEYS.themeColor) || config.branding.themeColor,
  };
}

/** The deployment's defaults, which an empty value goes back to. */
export function brandingDefaults(): Branding {
  return { ...config.branding };
}

function clean(value: string, label: string, max: number): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > max) throw new UserInputError(`${label} is limited to ${max} characters.`);
  return text;
}

/** "#1c7ed6", "#1C7ED6" or "1c7ed6" → "#1c7ed6"; three-digit forms expand. */
export function normalizeColor(raw: string): string {
  const hex = raw.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${[...hex].map((c) => c + c).join("")}`;
  throw new UserInputError("Pick a colour, like #1c7ed6.");
}

/**
 * Change any of the three. An empty value goes back to the deployment's
 * default. Each change is audited.
 */
export function setBranding(changes: Partial<Branding>, actorUserId: number): Branding {
  if (changes.name !== undefined) {
    writeSetting(KEYS.name, clean(changes.name, "The name", BRANDING_LIMITS.name), actorUserId);
  }
  if (changes.shortName !== undefined) {
    writeSetting(KEYS.shortName, clean(changes.shortName, "The short name", BRANDING_LIMITS.shortName), actorUserId);
  }
  if (changes.themeColor !== undefined) {
    const raw = changes.themeColor.trim();
    writeSetting(KEYS.themeColor, raw ? normalizeColor(raw) : "", actorUserId);
  }
  return branding();
}
