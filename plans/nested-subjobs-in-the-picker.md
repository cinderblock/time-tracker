# Sub-jobs nested in the job picker

## Goal

A job list that is a tree should read as a tree. Jobs under customers already
group (a customer is a heading, never a choice), but a job's *sub-jobs* are
listed flat beside it, each line repeating the parent's name:

```
Riverside            ← customer heading (good)
  Phase 1
  Phase 1:Deck       ← a sub-job, as its own line item with the prefix
  Phase 1:Roof
  Phase 2
```

It should read:

```
Riverside
  Phase 1
    Deck
    Roof
  Phase 2
```

The same complaint applies to the admin Jobs page, which lists a customer's
jobs flat with `nameWithin` labels ("Phase 1:Deck").

The user also noted that jobs with sub-jobs usually aren't allowed to take
hours — "either way, they should be presented as nested options". So the
picker must draw a nesting row for a job that can't take time itself, as well
as a pickable row for one that can.

## Environment / context

- Repo `cinderblock/time-tracker` (public), branch `master`, Bun. Checks:
  `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e` (builds first;
  run through `~/.claude/bin/cpu-slots.mjs`, 3 slots).
- **Shared working tree.** Another session has uncommitted work in
  `app/tracker/{EntryList,NotesPanel,TrackerScreen}.tsx`, `src/settings.ts`,
  `src/approvals.ts`, `src/entry-status.ts`, `src/sync.ts`, `src/db.server.ts`
  plus new `app/tracker/flight*`. None of those are touched here; only my own
  paths get staged.
- Jobs nest arbitrarily deep (`jobs.parent_id`); QuickBooks sends
  customer → job → sub-job as rows with a `Customer:Job:Sub` full name.
  `src/jobs.ts` already computes `fullName`, `customerId`, `open`, `bookable`.
- The picker is one shared component, `app/tracker/JobPicker.tsx`
  (`JobSelect`), used by `TimerCard` (×2), `NotesPanel` (×2) and
  `EntryEditor`. Fixing it fixes every place a job is chosen.

## Decisions already made (don't re-ask)

1. **The booking rule doesn't change here.** A job with sub-jobs still takes
   time itself (plan `jobs-under-customers.md`, decision 2 — "as in
   QuickBooks"). The user said "either way", so this is presentation only. The
   picker handles both: an unbookable job with bookable sub-jobs is drawn as a
   nesting row that can't be chosen.
2. **Customers stay group headings** (Mantine `Combobox.Group`), as today.
   Jobs nest *inside* a customer's group by indentation, because Mantine's
   `Select` data can only group one level deep.
3. **Stay on Mantine `Select`.** A hand-rolled `Combobox` would allow true
   nested groups and non-interactive rows, but would rewrite the most-used
   control in the app and its 15+ e2e interactions. Indentation inside one
   group plus a custom filter gets the same reading with a fraction of the
   risk.
4. **A search keeps a match's ancestors on screen.** Filtering a tree by label
   alone leaves children floating under nothing. The custom filter keeps any
   job that matched *or* has a match below it, so the path to a match is
   always visible — and drops customer headings with nothing left under them
   (Mantine's default filter keeps those, showing bare headings).
5. **Option labels stay full "Customer:Job:Sub" paths.** They are what the
   closed input shows and what typing matches against; `renderOption` draws
   the indented short name. (Unchanged from the first round.)
6. **No new way to create a sub-job.** The op already allows it
   (`job.create` with a job as `parentId`) and QuickBooks sends them; the
   admin page grows nesting, not another form. e2e makes its nested fixture
   through the API.
7. **Deep names elsewhere are out of scope.** A recent-job button and the
   timer card still show "Phase 1:Deck" over the customer name
   (`splitJobName`). Changing that means editing files the other session has
   open; noted as a follow-up.

## Plan / steps

1. [x] Plan written.
2. [x] `app/tracker/job-groups.ts`: `jobTree()` — customers with their jobs as
   `JobNode` trees, siblings by name, rows whose line of parents is missing
   left out, and (for the picker) subtrees with nothing bookable pruned while
   keeping an unbookable job that has bookable sub-jobs. `groupJobs()` returns
   trees; `jobRows()` flattens one for drawing, with each row's depth.
3. [x] `JobPicker.tsx`: options in tree order, indented by depth, labelled
   with the job's own name; an unbookable job is `disabled` and reads
   "sub-jobs only"; `JobPicker.module.css` keeps such a row legible (Mantine
   dims disabled options to 0.35); ancestor-keeping filter per decision 4.
4. [x] Admin Jobs page: a customer's jobs nested, each labelled within its
   parent.
5. [x] Unit tests for the tree (depth, pruning, unbookable parents, cycles).
6. [x] e2e: a nested fixture through the API, then the picker shows "Deck"
   indented under "Phase 1" and the whole path once chosen.
7. [x] README's picker paragraph mentions sub-jobs. (That one paragraph was
   swept into the peer session's commit 0766d7c, which staged the README
   wholesale — the words are right, the commit isn't mine. Nothing to undo.)
8. [x] typecheck, unit tests and the chromium e2e project green; committed.

## Round two (2026-09-21, after seeing it)

The user's answers to the two open questions, which change the rules rather
than the drawing:

**R1. Whether a job takes hours is a per-job setting, and the default is that
a job with sub-jobs does not.** So `bookable` stops being "any job under an
open customer": a job that holds sub-jobs takes no hours *unless an admin says
it does*, and an admin can equally say a childless job takes none. Stored as a
nullable override (`jobs.takes_time`: NULL = follow the default, 1 = yes,
0 = no), so the default keeps following the tree as sub-jobs come and go. This
is what makes the picker's "sub-jobs only" row real rather than theoretical.

**R2. No depth cap** — "as many layers as are configured". The indent step
stays 16px and simply repeats; QuickBooks tops out at five levels anyway.

**R3. The ":" path separator never appears inline in the UI.** Where the whole
path has to read on one line it is `Riverside › Phase 1 › Deck`; where there
are two lines it is the job's own name with its place dimmed beneath it (the
user's choice, 2026-09-21):

```
Deck
Riverside › Phase 1
```

Assumption stated rather than asked: data keeps colons — the CSV export's Job
column, what goes to QuickBooks, and job names as QuickBooks reports them
back. Those are interop, not display, and QuickBooks' own convention is the
colon. The Accounting page *does* draw QuickBooks' names with "›" like
everything else.

### Round two steps

1. [x] `src/job-names.ts`: `jobPath()` (name + the place above it) and
   `jobLabel()` (one-line "›" breadcrumb), with tests. In `src/` because both
   the server (reports, sync messages) and the browser need them.
2. [x] `src/jobs.ts` + migration `005_takes_time`: `hasSubJobs`, `takesTime`
   (the override), `bookable` from the pair; `requireBookableJob` explains
   "only holds its sub-jobs"; `updateJob({ takesTime })`. Offline reducer
   follows: a job created under another makes that one stop taking hours.
3. [x] Admin Jobs page: a "Takes hours" switch per job, saying when it is
   following the default and offering a way back to it.
4. [x] Display sweep, no ":" left in the UI: picker (option labels, recents,
   input), timer card, recent buttons, notes panel, entry list and its toasts,
   calendar, rates, reports (+ `jobOptions`), accounting, Jobs-page messages,
   sync refusal messages.
5. [x] Tests: unit for the rule and the names; e2e picks up that "Phase 1" is
   now a heading until an admin switches its hours on.
6. [ ] README and this plan; typecheck, unit, chromium e2e; commit.

## Findings / gotchas

- Mantine `Select` data groups are one level only (`{ group, items }`), and
  `items` can't hold another group. Nesting has to be drawn inside the group.
- A `disabled` item is exactly right for a nesting row: `Combobox.Option`
  guards its `onClick`, and keyboard nav skips `[data-combobox-disabled]`
  (`get-index.mjs`). It still renders `role="option"`, so an e2e assertion
  that it "isn't a choice" has to check the attribute (or that clicking it
  does nothing), not the role.
- Mantine dims disabled options with `opacity: 0.35`, which a child can't
  undo — hence the one-rule CSS module rather than a style prop.
- Mantine's `defaultOptionsFilter` pushes a group even when every item in it
  was filtered out, and `Combobox.Group` renders its label with no children:
  bare headings while searching. The custom filter drops empty groups.
- Because option labels are full paths, typing a parent's name already keeps
  its whole subtree (every descendant label contains the parent's name). Only
  the ancestors of a match needed adding back.
- `renderOption` receives the parsed option, so extra fields on a data item
  are not to be relied on: depth and short names live in a `Map` keyed by the
  option value (the pattern the "Recent" group already used).
- e2e: `pickJob()` fills the search box and clicks `getByRole("option", {
  name, exact: true })`. Under a customer that name is now the job's *own*
  name — for a sub-job, "Deck", not "Phase 1:Deck". The dropdown is portalled,
  so options are *not* inside the modal's DOM: query them from the page (or
  from `getByRole("listbox")`, which is what scopes the group-heading checks
  away from the customer name printed on the timer card behind the dialog).
- `jobTree` is generic over anything with `{ id, name, fullName, parentId }`
  (`JobLike`), which is how the admin page — whose loader shape has no
  `bookable` — reuses it. What to prune is a `keep` predicate; the picker
  passes `(j) => j.bookable`, the admin page passes nothing and keeps
  everything, empty customers included.
- Nesting made the "Needs a note (the customer's rule)" label wrong for a
  sub-job whose rule comes from the job above it. Each row now carries the
  nearest row above that asks for a note and names it.
- **The "sub-jobs only" row cannot occur in the app as it stands**, so it is
  the one part of this that a browser never exercised. `open` is inherited
  (`src/jobs.ts`): closing a job closes everything under it, so a job that
  can't take time never has a sub-job that can. The tree logic for it is
  unit-tested, and it becomes real the moment open question 1 is answered
  yes.
- The e2e suite could not be verified in the shared checkout: a peer session's
  uncommitted sync/approvals work was in the build and `offline.spec.ts:130`
  hung with "1 to sync" undrained, which then took the app server down for
  every file after it. Verified instead in a throwaway worktree at HEAD plus
  my files alone (`git worktree add`, `node_modules` junctioned in,
  `E2E_PORT=3160` so it can't collide with the peer's own worktree run), and
  with `cpu-slots.mjs` for 3 slots, which queued behind theirs rather than
  overloading the machine.

### Round two findings

- The rule is structural: a job *holds* sub-jobs whether or not those are
  open, so closing the only sub-job doesn't hand hours back to the parent.
  Simpler to explain, and an admin who wants it back says so on the Jobs page.
- A QuickBooks pull that adds a sub-job under a job people have been booking
  to will quietly stop that job taking hours — the rule working as asked, but
  worth knowing when someone says "my job vanished from the picker". Their
  running timer is untouched; the job just stops being offered.
- `jobs.takes_time` is NULL by default and `CHECK (takes_time IN (0, 1))`
  still allows NULL (a CHECK only fails on a definite false).
- Rows merged into another keep their `parent_id`, so `hasSubJobs` counts only
  rows that haven't been merged away — otherwise a provisional job that was
  linked elsewhere would leave its old parent looking like a holder forever.
- Two e2e expectations are *data*, not display, and keep their colons: the
  fake QuickBooks' own `fullName`s (`accounting.spec.ts`) and the CSV's Job
  column (`timesheets.spec.ts`).
- A disabled Mantine option still answers `getByRole("option")`, and its
  accessible name now includes the hint — "Phase 1 sub-jobs only". Tests match
  on that or on `data-combobox-disabled`.

## Progress log

- 2026-09-21 — Plan; `jobTree`/`jobRows` with tests; picker draws the tree
  with an ancestor-keeping filter; admin Jobs page nests sub-jobs; e2e fixture
  "Hillside → Phase 1 → {Deck, Roof}". Typecheck clean; 290 unit tests pass in
  the shared checkout. The chromium e2e project was run in the verification
  worktree at 5828aa7 plus my files: **45 passed, 0 failed**, the new
  nested-jobs case among them, and `E2E_SCREENSHOTS` saved
  `job-picker-nested.png` — Hillside ▸ Phase 1 ▸ {Deck, Roof} with the
  sub-jobs set in, and Riverside's own jobs at the top level beneath it.
  The same suite in the shared checkout failed at `offline.spec.ts:130`
  ("1 to sync" never drained, taking the server down for every file after);
  that is the peer session's uncommitted sync work, since the identical files
  pass in the clean worktree. Committed as fde6798, then run once more with
  the worktree checked out at that commit — the peer's submit/approval work
  included — for **46 passed, 1 skipped (screenshots), 0 failed**.

## Open questions for the user

1. Should a job with sub-jobs stop taking hours (the "usually" in the
   request)? Today it still can. The picker already draws the unbookable case,
   so the change is one line in `src/jobs.ts`
   (`bookable: open && parentId != null && !hasChildren`) plus a rule about
   time already booked to such a job. Not done without a yes — it would
   silently make jobs unpickable at TWILL.
2. Want the same leaf-first treatment on the recent-job buttons and the timer
   card heading ("Deck", with "Riverside:Phase 1" beneath, instead of
   "Phase 1:Deck" over "Riverside")? Decision 7 left it out to stay clear of
   another session's files.
3. The Reports page's Job filter is still a flat list of full paths, on
   purpose: there a customer *is* a valid choice ("Includes its sub-jobs"), so
   the picker's rules don't apply. It could be nested with an indent the same
   way if the list gets long enough to bother.

## Things not to do

- Don't rewrite `JobSelect` on a bare `Combobox` for this (decision 3).
- Don't reuse a job id as a "Recent" option value — Mantine throws on
  duplicate values; the `recent:` prefix stays.
- Don't rely on Mantine's default filter once labels are paths: it leaves
  children without their parents and keeps empty headings.
- Don't touch `app/tracker/{EntryList,NotesPanel,TrackerScreen}.tsx`,
  `src/settings.ts` or the other files the peer session has open, and don't
  stage them.
- **Don't `git commit --amend` in this checkout without re-reading `HEAD`
  first.** It happened here: I committed `fde6798`, ran an e2e pass, and
  amended to record the result — but in those minutes the peer session had
  committed `6b8edc9` on top, so the amend rewrote *their* commit with my
  message. Repaired with `git reset --mixed 6b8edc9` (their sha, message and
  tree restored exactly; nothing was pushed, so no force-push was involved
  and none was needed) and the plan update went on top as its own commit.
  In a shared tree, "my last commit" stops being HEAD without warning:
  check `git rev-parse HEAD` against the sha you got, or just make a new
  commit.
