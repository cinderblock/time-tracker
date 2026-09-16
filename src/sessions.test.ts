import { beforeEach, describe, expect, test } from "bun:test";

import { sha256Hex } from "./crypto.ts";
import { db } from "./db.server.ts";
import {
  REFRESH_INTERVAL_MS,
  SESSION_TTL_MS,
  createSession,
  listSessions,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from "./sessions.ts";
import { freshDb } from "./testing/db.ts";
import { createUser, updateUserAccess } from "./users.ts";

beforeEach(freshDb);

const T0 = Date.parse("2026-09-16T12:00:00Z");

function person(role: "admin" | "employee" = "employee") {
  return createUser({ name: `${role}-${Math.random()}`, role, actorUserId: null });
}

describe("createSession", () => {
  test("stores the token's hash as the id, never the token", () => {
    const user = person();
    const { token, session } = createSession({ userId: user.id, credentialId: null, userAgent: "UA", now: T0 });
    expect(session.id).toBe(sha256Hex(token));
    expect(JSON.stringify(db().query("SELECT * FROM sessions").all())).not.toContain(token);
    expect(session.expiresAt).toBe(T0 + SESSION_TTL_MS);
  });

  test("truncates absurd user agents", () => {
    const user = person();
    const { session } = createSession({ userId: user.id, credentialId: null, userAgent: "x".repeat(5000) });
    expect(session.userAgent).toHaveLength(300);
  });
});

describe("resolveSession", () => {
  test("returns the person for a live token", () => {
    const user = person();
    const { token } = createSession({ userId: user.id, credentialId: null, userAgent: null, now: T0 });
    const resolved = resolveSession(token, T0 + 1000);
    expect(resolved?.user.id).toBe(user.id);
    expect(resolved?.refreshed).toBe(false);
  });

  test("rejects missing, unknown, expired and revoked tokens", () => {
    const user = person();
    const { token, session } = createSession({ userId: user.id, credentialId: null, userAgent: null, now: T0 });
    expect(resolveSession(null)).toBeNull();
    expect(resolveSession("")).toBeNull();
    expect(resolveSession("nope", T0)).toBeNull();
    expect(resolveSession(token, T0 + SESSION_TTL_MS)).toBeNull();

    revokeSession({ id: session.id, userId: user.id, actorUserId: user.id });
    expect(resolveSession(token, T0 + 1000)).toBeNull();
  });

  test("the hash itself is not a usable token", () => {
    const user = person();
    const { session } = createSession({ userId: user.id, credentialId: null, userAgent: null, now: T0 });
    expect(resolveSession(session.id, T0)).toBeNull();
  });

  test("rejects sessions of deactivated people", () => {
    const admin = person("admin");
    const user = person();
    const { token } = createSession({ userId: user.id, credentialId: null, userAgent: null });
    updateUserAccess({ userId: user.id, active: false, actorUserId: admin.id });
    expect(resolveSession(token)).toBeNull();
  });

  test("slides expiry forward at most once per refresh interval", () => {
    const user = person();
    const { token } = createSession({ userId: user.id, credentialId: null, userAgent: null, now: T0 });

    const early = resolveSession(token, T0 + REFRESH_INTERVAL_MS - 1)!;
    expect(early.refreshed).toBe(false);
    expect(early.session.expiresAt).toBe(T0 + SESSION_TTL_MS);

    const later = T0 + REFRESH_INTERVAL_MS;
    const refreshed = resolveSession(token, later)!;
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.session.expiresAt).toBe(later + SESSION_TTL_MS);

    // Persisted: a phone used every few months keeps its session alive past
    // the original expiry.
    const muchLater = T0 + SESSION_TTL_MS + 1000;
    expect(resolveSession(token, muchLater)?.user.id).toBe(user.id);
  });
});

describe("revoking", () => {
  test("revokeSession only touches the named person's session", () => {
    const a = person();
    const b = person();
    const { token, session } = createSession({ userId: a.id, credentialId: null, userAgent: null });
    revokeSession({ id: session.id, userId: b.id, actorUserId: b.id });
    expect(resolveSession(token)).not.toBeNull();
  });

  test("revokeAllSessions can spare the current session", () => {
    const user = person();
    const keep = createSession({ userId: user.id, credentialId: null, userAgent: "keep" });
    const drop1 = createSession({ userId: user.id, credentialId: null, userAgent: "drop" });
    const drop2 = createSession({ userId: user.id, credentialId: null, userAgent: "drop" });

    expect(revokeAllSessions({ userId: user.id, exceptId: keep.session.id, actorUserId: user.id })).toBe(2);
    expect(resolveSession(keep.token)).not.toBeNull();
    expect(resolveSession(drop1.token)).toBeNull();
    expect(resolveSession(drop2.token)).toBeNull();
    expect(listSessions(user.id).map((s) => s.userAgent)).toEqual(["keep"]);

    expect(revokeAllSessions({ userId: user.id, actorUserId: user.id })).toBe(1);
    expect(listSessions(user.id)).toEqual([]);
  });
});
