# Time the accounting system already has, and jobs that aren't billable

## Goal

Two things a first real send turned up, both about not putting the wrong thing
into the books.

1. **Don't add time the accounting system already has.** An organisation
   moving over from another tracker runs both for a while, and the other one
   keeps feeding the same accounting system. Sending this app's copy of a day
   that is already there books it twice. The sync should notice, hold the entry,
   and let an admin say which it is — rather than anyone finding out at invoice
   time.
2. **A job can be not billable.** Internal work (administration, the
   organisation's own projects) is tracked like any other, but must not show up
   as billable time. Until now every entry went as billable whenever it had a
   job and a service item.

## Decisions already made (don't re-ask)

1. **Checked once, before an entry's first send.** Not on amendments (the
   record there is already ours) and not after an uncertain send (that is
   `entry.find`, which looks for our own reference).
2. **A match is: same person, same date, same job, and not ours.** A record is
   ours if an entry here holds its id, or its note carries one of this app's
   `[ref …]` tags. Hours and notes are *not* compared: two systems rarely agree
   on either, and the person is asked anyway. Same day on a *different* job is
   not a match.
3. **Held, not refused.** A held entry isn't an error and isn't retried. It
   waits on the Accounting page with what was found, and an admin picks:
   - **Same time — replace it**: the entry adopts the record there and the next
     pass amends it to match this app (this app owns time; see types.ts).
   - **Different time — send both**: the entry is sent as a new record.
   - **Check again**: after fixing it in the accounting system by hand.
   Deleting the entry here is the ordinary delete; nothing new for it.
4. **The answer is remembered against what was checked** (date, person, job).
   Take the entry back and move it to another day or job, and it is checked
   afresh.
5. **Billable is a per-job answer that follows the tree**, like "needs a note":
   NULL follows the row above, and the top default is billable. A customer can
   carry it for all its jobs. It is applied when the record is built, so
   changing it affects time not yet sent and the next amendment of time that
   was — never rewrites what is there by itself.
6. **Admin page only.** The person whose time it is doesn't see the hold on
   their day screen: that would put accounting state into the offline model.
   Whoever reconciles the books needs the admin role.

## Plan / steps

- [x] 1. Migrations `006_job_billable`, `007_duplicate_check`.
- [x] 2. `jobs.ts`: `billable` (own answer) and `billed` (what applies);
      `updateJob`. `sync.ts`: the record's billable flag honours it.
- [x] 3. `FoundTime.jobRemoteId` from both backends.
- [x] 4. `sync.ts`: `entry.check` work, the hold, `resolveDuplicate`,
      `recheckDuplicates`, the overview.
- [x] 5. Jobs page switch; Accounting page section.
- [x] 6. Tests (unit through the real bridge client and the pretend
      QuickBooks; Web Connector parse), README.

## Findings / gotchas

- **A check is a `time.find` request**, the one `entry.find` already uses, so
  the Web Connector needed nothing new beyond reading the job off each record.
- **The bridge filters time by person *name***; this app knows the id, so the
  bridge client asks for the date and filters here (already true for
  `entry.find`).
- **The hold must not count as "ready"** in the overview, or the page says
  time will be sent that never will be.
- **Replacing sends a Mod with the edit sequence seen at check time.** If the
  record changed since, the existing stale path fetches it and tries again; if
  it was deleted there, the existing missing path adds it afresh. Nothing new
  was needed for either.

## Things not to do

- Don't compare hours or notes to decide a match (decision 2).
- Don't auto-resolve a hold in either direction. Adopting silently rewrites
  someone else's record; sending silently double-books.
- Don't treat a record carrying any `[ref …]` as foreign — it is another of
  this app's entries on the same job and day, which is normal.
- Don't read the billable switch into `rate_snapshot` or reports' cost:
  billable is about the accounting record, cost is about the rate.

## Round two: the person sees and fixes it (2026-10-02)

Decision 6 is reversed. The first real hold showed why: the person whose time
is held is the one who knows whether it is the same work, and nobody tells
them. Admin-only meant it waited for someone to open a page nobody opens.

- **Marked on their day.** A held entry carries `heldBy` on the day model —
  the records found — and shows an "already in QuickBooks" badge. A banner
  under the day header links to any other days with held entries.
- **Side by side.** A panel above Submit shows, per held entry, this app's
  entry next to what QuickBooks has, and the four ways out, each with its
  consequence in one line: keep mine (replace QuickBooks' record), keep
  QuickBooks' (delete mine), they're different (send both), I fixed it in
  QuickBooks (check again).
- **An op, `duplicate.resolve`**, like every other change: it goes through the
  outbox, works in acting-for mode, and the reducer mirrors it. The owner may
  resolve their own entries; the admin page still resolves anyone's through
  the same function.
- **`heldBy` stays on the entry whatever its status**, and the screen shows
  it only while the entry is signed off. Otherwise taking a day back and
  submitting it again would need the reducer to know what the server knows.
- "Delete mine" reopens the person's own submission and soft-deletes the
  entry in one transaction; an admin's approval still stops it, with the
  usual "ask an admin".

### Steps

- [x] `duplicate.resolve` op; `resolveDuplicate` shared by the op and the
      admin page (OpError → UserInputError there); `heldEntries(userId)`.
- [x] `EntryView.heldBy`, `DayModel.heldDays`; reducer mirror, including
      a day taken back dropping out of `heldDays`.
- [x] `HeldEntries.tsx`: the banner, the badge on the row, the side-by-side
      and the four choices. Buttons wrap on a phone — Mantine's don't by
      default, and a clipped label was the first thing the phone screenshot
      showed.
- [x] Tests: sync (every path, owner check, admin acting for), reducer
      mirror (through the pretend bridge), e2e on the day screen (replace;
      delete mine), README.

### Traps met

- The op description switch in `SyncStatusBadge.tsx` is exhaustive: a new
  op type fails typecheck there until it has words.
- On the day screen the recent-job buttons also carry the job's name, so an
  e2e locator for "the card with this job" must use `[data-entry-id]`.
- A held entry with no note on either side says "No note" twice.
