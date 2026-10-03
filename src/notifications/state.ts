import { db } from "../db.server.ts";
import { getOpenEntry } from "../entries.ts";
import { isEditable } from "../entry-status.ts";
import { pendingNotesBefore } from "../notes.ts";
import { heldEntries, syncOverview } from "../sync.ts";
import { durationSeconds, workDateOf, zonedParts } from "../time.ts";
import type { PersonState } from "./rules.ts";
import { isDayOff } from "./store.ts";

/** What anyone's time has waiting on an admin; worked out once per pass and shared by every admin. */
export function adminAttention(now: number): NonNullable<PersonState["attention"]> {
  const o = syncOverview(now);
  return {
    held: o.duplicates.map((d) => d.entryId),
    blocked: o.blocked.map((b) => b.entryId),
    failed: o.failed.map((f) => f.entryId),
  };
}

/** Everything the rules need to know about one person, now. */
export function personState(args: {
  userId: number;
  isAdmin: boolean;
  now: number;
  timeZone: string;
  attention: () => NonNullable<PersonState["attention"]>;
}): PersonState {
  const { userId, now, timeZone } = args;
  const today = workDateOf(now, timeZone);
  const clock = zonedParts(now, timeZone);

  const open = getOpenEntry(userId);
  const jobName = open?.jobId
    ? (db().query<{ name: string }, [string]>("SELECT name FROM jobs WHERE id = ?").get(open.jobId)?.name ?? null)
    : null;

  const secondsToday =
    db()
      .query<{ s: number | null }, [number, string]>(
        `SELECT SUM(duration_seconds) AS s FROM time_entries
          WHERE user_id = ? AND work_date = ? AND status != 'open' AND deleted_at IS NULL`,
      )
      .get(userId, today)?.s ?? 0;

  const notesToday =
    db()
      .query<{ n: number }, [number, string]>(
        `SELECT COUNT(*) AS n FROM day_notes
          WHERE user_id = ? AND work_date = ? AND deleted_at IS NULL AND rolled_into_entry_id IS NULL`,
      )
      .get(userId, today)?.n ?? 0;

  const draftDays = db()
    .query<{ work_date: string }, [number, string]>(
      `SELECT DISTINCT work_date FROM time_entries
        WHERE user_id = ? AND work_date <= ? AND status = 'draft' AND deleted_at IS NULL
        ORDER BY work_date DESC LIMIT 31`,
    )
    .all(userId, today)
    .map((r) => r.work_date);

  // As the day screen's banner counts them: only signed-off time is held in
  // earnest; a draft that was held has been taken back to change.
  const held = [...heldEntries(userId)]
    .filter(([, h]) => !isEditable(h.status))
    .map(([entryId, h]) => ({ entryId, workDate: h.workDate }));

  const failed = db()
    .query<{ id: string; work_date: string; sync_error: string | null }, [number]>(
      `SELECT id, work_date, sync_error FROM time_entries
        WHERE user_id = ? AND status = 'sync_failed' AND deleted_at IS NULL
        ORDER BY work_date`,
    )
    .all(userId)
    .map((r) => ({ entryId: r.id, workDate: r.work_date, error: r.sync_error ?? "Refused" }));

  return {
    isAdmin: args.isAdmin,
    today,
    minutesNow: clock.hour * 60 + clock.minute,
    dayOff: isDayOff(userId, today),
    secondsToday,
    timer: open
      ? {
          entryId: open.id,
          job: jobName,
          seconds: durationSeconds(open.segments, now),
          running: open.segments.some((s) => s.endedAt == null),
        }
      : null,
    notesToday,
    notesEarlier: pendingNotesBefore(userId, today),
    draftDays,
    held,
    failed,
    attention: args.isAdmin ? args.attention() : null,
  };
}
