# One field for a duration

## Goal

Type a duration into **one** field, the way it is said out loud, instead of
tabbing between an "Hours" box and a "Minutes" box. Both decimal hours
(`1.5`) and clock style (`1:30`) are read, and the field says back what it
understood.

Two dialogs ask for a duration today, and both had the two-box pair:

- `app/tracker/EntryEditor.tsx` — "Add time" / "Edit entry" in duration mode.
- `app/tracker/NotesPanel.tsx` — the per-job "Hours for …" dialog, which
  arrives with a suggestion from the day's notes.

## Environment / context

- Same repo and checks as `plans/time-tracker.md`: `bun run typecheck`,
  `bun test src/ app/`, `bun run test:e2e`.
- The parse belongs in `src/time.ts` with the other wall-clock helpers, so it
  is a unit test rather than a browser test.
- `src/limits.ts` is the dependency-free module made for limits the browser's
  fields and the server's validation share; `MAX_ENTRY_SECONDS` moved there
  from `src/ops-schema.ts` so a field can name the 24-hour cap without
  dragging zod into the client bundle.

## Decisions already made (don't re-ask)

1. **A bare number is hours**, decimal included: `2` = 2h, `1.5` = 1h 30m,
   `.75` = 45m. It is what "hours" in the old label meant, and it is what
   payroll decimal hours look like. `90` is therefore 90 *hours*, which the
   24-hour check catches and says so.
2. **Clock style is `h:mm`**, with `:45` allowed for a bare three-quarters of
   an hour and `h:mm:ss` accepted so an entry carrying seconds survives a
   round trip. Anything else — `1h30m`, `90m`, `1h 30`, `45 min` — is read
   too; the hint shows three forms, not all of them.
3. **Everything rounds to the minute** unless seconds were explicitly typed.
   Otherwise `7.33` would store 26 388 s, redisplay as `7:20`, and silently
   change the entry on the next save.
4. **The field says what it understood**, under it, as `1h 30m` — the same
   words the entry row uses. An unreadable value is an error on the field, not
   a silent zero, and the dialogs refuse to save it.
5. **One shared component**, `app/components/duration-input.tsx`, so the two
   dialogs can't drift apart.
6. **`inputMode` stays text.** A numeric or decimal keypad on iOS has no `:`,
   which would make clock style untypable on the device most used here.
7. **The notes dialog still suggests whole minutes.** Its suggestion comes
   from note timestamps and has arbitrary seconds; showing `2:07:43` would be
   noise. The editor, by contrast, shows an entry's seconds if it has any.

## Plan / steps

1. [x] Plan written.
2. [x] `parseDuration` and `formatDurationInput` in `src/time.ts`, with unit
   tests covering each accepted form and the rejected ones.
3. [x] `MAX_ENTRY_SECONDS` to `src/limits.ts`; `ops-schema.ts` and
   `entries.ts` import it from there.
4. [x] `app/components/duration-input.tsx`: a text field, a hint, the readout,
   the over-24-hours error, select-on-focus.
5. [x] `EntryEditor.tsx` and `NotesPanel.tsx` use it; save paths validate a
   readable, positive duration.
6. [x] e2e specs type into the one field (`tracking.spec.ts`,
   `accounting.spec.ts`), including a decimal and a clock value.
7. [x] README's manual-entry line mentions the accepted forms.
8. [x] typecheck, unit and e2e green; committed.

## Findings / gotchas

- Client components may only take **types** from `src/ops-schema.ts`; it
  imports zod, so a value import ships the validator to the browser. That is
  why the 24-hour cap moved to `src/limits.ts`.
- `formatDuration` in `src/time.ts` is the *timer* readout: under an hour it
  prints `mm:ss`, so `45:00` would mean 45 minutes there and 45 hours in a
  duration field. `formatDurationInput` is separate for that reason and always
  prints the hour.
- Playwright's `getByLabel` matches substrings: a field labelled "Hours" and
  the dialog titled "Hours for …" both answer to `Hours`. The new label is
  "Time worked", which collides with nothing.
- **Found while screenshotting this, and fixed:** making a job from inside the
  "Add time" dialog also submitted the entry form behind it, which answered
  "Pick a job." to a job being made. React events bubble up the *component*
  tree, so the new-job modal being a portal is no escape — `create` in
  `JobPicker.tsx` now stops propagation as well as the default.

## Progress log

- 2026-09-21 — Built in one pass: parser, shared field, both dialogs, specs.
  Verified: typecheck clean, 299 unit, 63 e2e (one notes-mode failure under
  load re-ran clean alone), and a throwaway spec screenshotted every state of
  the field — empty, decimal, clock, over 24 hours, unreadable, on a 390px
  phone, and the notes dialog's suggestion. The nested-form bug above turned
  up in those screenshots.

## Open questions for the user

None.

## Things not to do

- Don't set `inputMode="decimal"` "for the phone keypad" — see decision 6.
- Don't make the field normalise itself on blur (`1.5` → `1:30`). The readout
  already says what it understood, and rewriting what someone typed while they
  are still working fights them.
