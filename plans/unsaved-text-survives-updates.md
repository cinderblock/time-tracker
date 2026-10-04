# Unsaved text survives app updates (and any other reload)

## Goal

People type into a field, don't save, and a new release reloads the page
under them — the text is gone (reported 2026-10-03). The installed app
reloads itself the moment a new service worker takes over
(`app/pwa/auto-update.ts`, whose own header accepted this: "unsaved text in
an open dialog is lost if a deploy lands mid-edit"). That trade is reversed:
**nothing a person has typed is lost to an update.**

The user's ask, in order of preference: re-apply the same changes after the
reload ("HMR style"); failing that, at least keep the data; failing that,
warn them to copy it out (selection and copying, no editing, while the
server is unreachable).

## Environment / context

- Same worktree and branch as `plans/one-line-per-job-and-notes-flexibility.md`
  (`~/git/Personal Projects/time-tracker-notes`, `notes-flexibility`); it all
  deploys together.
- Reload path: `startAutoUpdate()` → `createUpdater` (`app/pwa/auto-update.ts`)
  → `applyUpdate()` → `window.location.reload()`, on `controllerchange` or a
  stranded page. Tested as pure rules in `app/pwa/auto-update.test.ts`.
- Tracking changes already never depend on the server being up: every change
  is an op in the IndexedDB outbox (`app/offline/`). What can be lost is only
  text typed and not yet saved — still in a field's React state.

## Decisions already made (don't re-ask)

1. **Restore, don't just warn** (user's first preference). Fields on the
   tracking screen keep their unsaved text on the device as it's typed
   (localStorage, per person, per field), and put it back after any reload —
   an update, a crash, a closed tab, a phone that killed the app. An open
   dialog that was being filled in reopens with what was in it.
2. **Updates wait for a good moment.** The reload is held while a text field
   has focus, or any typed-and-unsaved text exists that isn't restorable
   (e.g. an admin form); a quiet "a new version is ready" line offers to load
   it now. With only restorable drafts, it reloads when the app goes to the
   background, or once nobody is typing.
3. **No read-only "copy it out" mode.** Typing works with the server down:
   tracking changes queue on the device, and drafts are kept there. The
   fallback the user described is only needed where saving needs the server
   (admin forms); there the update simply waits, and the text stays editable.

## Design

- `app/drafts/` — a small store (`localStorage`, key
  `tt-draft:<person>:<field>`, value + time; older than a week dropped) and
  `useDraft(key, initial)`: state like `useState`, read back after hydration,
  written as it changes, cleared when the change is saved or cancelled.
  Fields it manages carry `data-draft` so the page-wide watcher knows they
  are safe.
- `app/pwa/unsaved.ts` — the page-wide watcher: an `input` listener marks
  edited text fields; a form `submit`/`reset`, or the field emptying, clears
  them. `reloadWouldLoseText()` is true when a marked field without
  `data-draft` still holds text, or a text field has focus.
- `createUpdater` gets `canReloadNow()` and holds a pending update instead of
  reloading; `retry()` is called on focus-out, input, visibility change and
  dialog close. `UpdateReady` shows the line with "Load it now".

## Plan / steps

1. ✅ Draft store + `useDraft` (`app/drafts/drafts.ts`) + unit tests.
2. ✅ Tracking screen: note box (per job and day), timer note, note editing
   (open + text + job), hours dialog (open + total + note), entry editor
   (open + every field; the form carries `data-draft`). Helper
   `useTrackerDraft` scopes keys per person / acting-for.
3. ✅ Watcher (`app/pwa/unsaved.ts`) + updater waiting (`safeToReload`,
   `retry`, `loadNow`) + `UpdateReady` line; unit tests of both.
4. ✅ e2e: note box and an open "Add time" dialog come back after a reload;
   gone once saved or cancelled.
5. ✅ README; auto-update header comment rewritten. Commit; deploy with the
   one-line-per-job work.

## Findings / gotchas

- `useDraft` reads storage after mount (an effect), so components that also
  "keep in step" with server data in an effect must not overwrite a draft
  just put back: the timer note now only follows `entry.note` when it
  *changes*, not on first show.
- After a switch or a stop the card may already show another timer when the
  answer arrives, so the old timer's draft is removed by the key captured
  when the action started (`useTrackerDraftKey`), not by the hook's
  `discard()`, which acts on the current key.
- No DOM library in the unit tests: the watcher is tested against small
  fakes (fields, forms, focus); its real wiring (focus-out, input,
  visibility) is only exercised indirectly — there is no way in e2e to make
  a new service worker take over on demand.
- e2e under load: see the one-line plan; this suite was confirmed on a quiet
  machine (81 passed).

## Progress log

- [x] 2026-10-03 — Asked for; design written.
- [x] 2026-10-03 — **Deployed** at `b68032f` (image `sha256:5f720ec8…`,
      revision label checked against the commit from the registry). A
      database snapshot was taken first; migrations `010` and `011` applied
      on the first start; the container came up healthy and serves the new
      service-worker build. On the live data every typed-in entry's time
      became untimed time with nothing mismatched, and no person had two
      lines for one job and day.
- [x] 2026-10-03 — Built: drafts, watcher, waiting updater, `UpdateReady`;
      typecheck; 471 unit; full e2e 81 passed (quiet machine).

## Open questions for the user

- (none)

## Things not to do

- Don't key drafts by person only: two people can use one device (sign out,
  sign in). Key by person and field, and acting-for an admin's own drafts are
  separate from the person's.
- Don't read localStorage during render: the server renders the empty field
  and hydration must match; read after mount.
