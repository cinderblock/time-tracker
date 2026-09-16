import { db } from "./db.server.ts";

export interface AuditEvent {
  /** Who did it. null for the system itself (startup bootstrap, CLI). */
  actorUserId: number | null;
  entity: string;
  entityId: string | number;
  action: string;
  before?: unknown;
  after?: unknown;
  deviceId?: string | null;
  at?: number;
}

/**
 * Append to the audit log. The table is append-only by convention: nothing in
 * the app may UPDATE or DELETE it.
 *
 * Never pass secrets here — tokens, public keys and cookie values stay out of
 * `before`/`after`. Callers pass the fields a human would want to see.
 */
export function audit(event: AuditEvent): void {
  db()
    .query(
      `INSERT INTO audit_log
         (actor_user_id, at, entity, entity_id, action, before_json, after_json, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.actorUserId,
      event.at ?? Date.now(),
      event.entity,
      String(event.entityId),
      event.action,
      event.before === undefined ? null : JSON.stringify(event.before),
      event.after === undefined ? null : JSON.stringify(event.after),
      event.deviceId ?? null,
    );
}

export interface AuditRow {
  id: number;
  actor_user_id: number | null;
  at: number;
  entity: string;
  entity_id: string;
  action: string;
  before_json: string | null;
  after_json: string | null;
}

export function auditFor(entity: string, entityId: string | number): AuditRow[] {
  return db()
    .query<AuditRow, [string, string]>(
      `SELECT id, actor_user_id, at, entity, entity_id, action, before_json, after_json
         FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id`,
    )
    .all(entity, String(entityId));
}
