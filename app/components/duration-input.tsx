import { Stack, Text, TextInput } from "@mantine/core";

import { MAX_ENTRY_SECONDS } from "../../src/limits.ts";
import { formatDurationHuman, parseDuration } from "../../src/time.ts";

/** The forms worth naming in the hint; `parseDuration` reads more than these. */
const FORMS = "1:30, 1.5, or 90m";

/**
 * What's wrong with a typed duration, in plain words, or null if it reads.
 * The field shows this once something has been typed; a form calls it again
 * on submit, where an empty field is a problem too.
 */
export function durationProblem(value: string, max: number = MAX_ENTRY_SECONDS): string | null {
  const seconds = parseDuration(value);
  if (seconds === null) return value.trim() === "" ? "Enter how long you worked." : `Enter a time like ${FORMS}.`;
  if (seconds <= 0) return "Enter how long you worked.";
  if (seconds > max) return `That's more than ${Math.round(max / 3600)} hours.`;
  return null;
}

/**
 * How long something took, in one field: hours and minutes as they are said
 * out loud. Decimal hours ("1.5"), clock style ("1:30") and named units
 * ("90m") all read; under the field is what was understood, in the same words
 * the day's entries use, so there is no guessing which was meant.
 */
export function DurationInput({
  label,
  value,
  onChange,
  max = MAX_ENTRY_SECONDS,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Longest duration that makes sense here, in seconds. */
  max?: number;
  /** In a form that won't submit without it; a field with a suggestion in it isn't. */
  required?: boolean;
}) {
  const seconds = parseDuration(value);
  // An empty field isn't an error until it's submitted — it's just not filled in yet.
  const problem = value.trim() === "" ? null : durationProblem(value, max);

  return (
    <Stack gap={4}>
      <TextInput
        label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        // Whatever is there is a whole small value; tapping in means replacing it.
        onFocus={(event) => event.currentTarget.select()}
        error={problem}
        placeholder="1:30"
        // Not "numeric" or "decimal": those keypads have no colon, which would
        // put clock style out of reach on a phone.
        inputMode="text"
        autoComplete="off"
        required={required}
      />
      {problem == null && (
        <Text size="sm" c="dimmed">
          {seconds != null && seconds > 0 ? formatDurationHuman(seconds) : `Hours and minutes — ${FORMS}`}
        </Text>
      )}
    </Stack>
  );
}
