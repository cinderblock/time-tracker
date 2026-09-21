# Submit, and approvals as an option

## Goal

Time reaches the accounting system because **the person who worked it says it is
done**, not because an admin signed it off. Admin approval stays in the product
but becomes an optional second gate, **off by default**.

The organisation driving this trusts its employees to report accurately, and
does not want an admin clicking approve on every week before anyone gets paid.
Other organisations may want the gate; they can turn it on.

## The ladder

    open -> draft -> submitted -> [approved] -> synced

- `open` — a timer that has not been stopped.
- `draft` — stopped, or typed in. The person can still change it.
- `submitted` — the person says this time is done. **This freezes the rate,
  locks the entry, and (with approvals off) makes it eligible to send.**
- `approved` — only reachable when approvals are on. An admin has signed it off.
- `synced` — recorded in the accounting system.

Every status in this ladder already existed before this change. `submitted` was
written into `src/entry-status.ts` from the start and left unused, with the plan
noting "a submit step can be added later without changing the model". This is
that step.

## Decisions already made (do not re-ask)

1. **Approvals are optional and off by default.** One organisation-wide setting,
   `require_approval`, alongside the others in `src/settings.ts`. Off means
   `submitted` is what the sync selects; on means `approved` is.
2. **Submit does not seal the day.** It locks the entries it covered, exactly as
   approve does today. A forgotten hour can be added to an already-submitted day
   as a fresh draft and submitted separately; it reaches the accounting system as
   another line. No day-level record, no new guards in `startTimer` or
   `createManualEntry`.
   - Considered and rejected: sealing the day. It would have closed a real gap
     (today you *can* add a new entry to an approved day), but it is a bigger
     change than the problem justifies, and a sealed day turns every forgotten
     hour into a support request.
3. **A person can take back their own time until someone else has signed off on
   it.** With approvals off nobody ever signs off, so they can always unsubmit,
   fix and resubmit. With approvals on, an admin's approval ends self-service and
   reopening is admin-only from there — today's behaviour, unchanged.
   - If the time already reached the accounting system, resubmitting amends the
     record there. `sync.ts` already does this: it sends a Mod for an entry that
     has a `remote_txn_id` and came back to `draft`.
4. **Submitting freezes `rate_snapshot`.** The freeze moves from approve to
   submit, because submit is now the first moment time is locked. Safe: the rate
   resolver keys off the entry's `work_date`, so the frozen number does not
   depend on *when* the freeze happens. Approving afterwards keeps the snapshot
   submit took rather than recomputing it.
5. **Nobody is auto-submitted.** Time that is never submitted never moves. It is
   made visible instead — to the person on their day screen, to admins on the
   timesheets grid — and an admin can submit on someone's behalf through the
   existing "acting for" path, so a forgetful person cannot hold up payroll.
   - Considered and rejected: auto-submitting days older than N. It puts a
     person's name on hours they never confirmed, which defeats having a submit
     step at all.
6. **Submit and unsubmit are ops**, like every other tracking write, so they go
   through the outbox and work offline. `rollup.commit` is the model: a
   day-scoped op carrying a `workDate`.

## Why the sync gate needed care

Approving does three separable things, and only the third is what "approval" as
a *policy* means:

1. freezes `rate_snapshot` — so a backdated raise never rewrites historical cost;
2. locks the entry — so payroll-relevant time cannot be quietly re-edited;
3. makes the entry eligible to send — `sync.ts` selects
   `status IN ('approved','sync_failed')`.

Turning approvals off without moving (1) and (2) somewhere would mean nothing
ever freezes a rate and nothing is ever final. Submit takes over (1) and (2);
the setting only moves (3).

## Findings / gotchas

- **Approving does not seal a day, and never did.** Only `updateEntry`
  (`src/entries.ts:419`) and `deleteEntry` (`src/entries.ts:502`) check
  `isEditable`. `startTimer` and `createManualEntry` have no day-level guard, so
  a new entry can be added to an approved day and lands as a fresh `draft`
  outside the approval. Decision 2 keeps it that way; this is documented so the
  next reader does not mistake it for a bug introduced here.
- **Two places select sendable work**, not one: `src/sync.ts:274` (the work
  list) and `src/sync.ts:523` (the counts shown to admins). Both need the gate,
  and both must keep their existing second arm — entries that were sent and came
  back to `draft`/`open`, which produce a Mod or a delete.
- **The Web Connector does not use the sync worker.** A poll backend asks for
  work itself through `listWork`, so anything that depends on the sync loop
  running would not apply to it. The gate lives in the query, which both
  backends go through.
- **`entry-status.ts` must stay dependency-free** — the browser's offline
  reducer imports it. The setting cannot be read there; it is passed in as data
  on the day model, the way `requireNoteOnStop` and `weekStartsOn` already are.
- **Migration `001` could not be touched**, even to fix a comment that now reads
  wrong ('Rate frozen at approval'). The runner hashes a migration's SQL text,
  comments included, and refuses to start if an applied one changed. The new
  columns are `004_submission`, which also backfills `submitted_at` from
  `approved_at` so time approved under the old rules reads the same way.
- **`.check()` on the approvals switch fails in Playwright.** It is a controlled
  Mantine `Switch` whose state comes back through a loader revalidation, so it
  is still unchecked when Playwright asserts. Use `.click()` and wait for the
  toast.
- **The offline reducer double-counts the week strip for an entry created on
  another day** — `findEntry` only looks at the day on screen, so its
  idempotency guard misses, and `addToWeek` runs twice. Pre-existing, and
  harmless in practice because the screen only ever dispatches ops for the day
  it is showing. Worth knowing before writing a reducer test that creates time
  on another date (one did, and failed for this reason).

## Plan / steps

- [x] 1. `require_approval` setting with its accessors in `src/settings.ts`.
- [x] 2. `src/entry-status.ts`: a sendable-statuses helper that takes the
      setting as an argument, and `lockedReason` wording for `submitted` that
      tells the owner they can take it back.
- [x] 3. `src/approvals.ts`: `submitEntries`, and taking back through the
      existing `reopenEntries` with an `ownSubmissionsOnly` flag rather than a
      separate `unsubmitEntries` — the two differ only in whether an admin's
      approval stops them. Approve keeps an existing snapshot instead of
      recomputing it, and records the submission when there wasn't one.
      `ApprovalResult` and `describeApproval` became `SignOffResult` and
      `describeSignOff(what, result)`, because the module now covers three
      actions rather than one.
- [x] 4. `src/sync.ts`: both selections honour the gate.
- [x] 5. Ops `day.submit` / `day.unsubmit`: schema, handlers, offline reducer.
- [x] 6. Day screen: submit a day, take it back, and what state it is in.
- [x] 7. Admin: the approvals toggle on settings; timesheets offers **one**
      action per row rather than two — approving already covers time nobody
      submitted, so where approval is required an admin approves the lot, and
      where it isn't they submit for someone who hasn't. Day cells say which,
      and a day is only shaded once it is as far as this organisation takes it.
- [x] 8. Reports: "approved hours" means "signed off" when the gate is off.
- [x] 9. Tests, e2e, README, and the design section of `plans/time-tracker.md`.

## Things not to do

- Do not auto-submit or auto-approve anything on a timer.
- Do not add a day-level seal (decision 2) without reopening that decision.
- Do not read settings from `src/entry-status.ts` or anything the offline
  reducer imports.
- Do not deploy from this repo. Deploys are an ops change, pinned by digest, and
  need their own approval.
