import { config } from "../../src/config.server.ts";
import { db } from "../../src/db.server.ts";
import { setDayOff, snooze, verifyActionToken } from "../../src/notifications/store.ts";
import { workDateOf } from "../../src/time.ts";
import { assertSameOrigin, isPost, readJson } from "../auth.server.ts";
import type { Route } from "./+types/api.notifications.action";

/**
 * POST /api/notifications/action — a button pressed on a notification, sent
 * by the service worker: `{ id, token, action }`. The token (see
 * actionToken) is the authority, not a session: the worker may run long
 * after any page that had one is gone, and the token can do exactly two
 * things to exactly one notification.
 */
export async function action({ request }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  const body = await readJson(request);
  const id = Number(body.id);
  const token = typeof body.token === "string" ? body.token : "";
  if (!Number.isInteger(id) || id <= 0 || !token) return Response.json({ error: "Incomplete." }, { status: 400 });
  const userId = verifyActionToken(token, id);
  if (userId == null) return Response.json({ error: "Not recognised." }, { status: 403 });
  const now = Date.now();

  switch (body.action) {
    case "snooze":
      snooze({ userId, logId: id, now });
      return Response.json({ ok: true });
    case "day-off": {
      // The day the reminder was about, even if the button is pressed later.
      const sentAt = db().query<{ first_at: number }, [number]>("SELECT first_at FROM notification_log WHERE id = ?").get(id)!.first_at;
      setDayOff({ userId, workDate: workDateOf(sentAt, config.timezone), off: true, actorUserId: userId, now });
      return Response.json({ ok: true });
    }
    default:
      return Response.json({ error: "Unknown action." }, { status: 400 });
  }
}
