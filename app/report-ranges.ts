/**
 * The date ranges a report can cover. Shared by the reports page and its
 * loader, so this module must stay free of server imports.
 */
export const RANGE_PRESETS = [
  { value: "this-week", label: "This week" },
  { value: "last-week", label: "Last week" },
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "custom", label: "Pick dates" },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]["value"];
