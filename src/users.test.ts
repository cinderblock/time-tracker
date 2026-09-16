import { beforeEach, describe, expect, test } from "bun:test";

import { auditFor } from "./audit.ts";
import { createSession, resolveSession } from "./sessions.ts";
import { freshDb } from "./testing/db.ts";
import {
  countActiveAdmins,
  createUser,
  listUsers,
  normalizeName,
  renameUser,
  updateUserAccess,
} from "./users.ts";

beforeEach(freshDb);

describe("normalizeName", () => {
  test("trims and collapses whitespace", () => {
    expect(normalizeName("  Ada   King \n Lovelace ")).toBe("Ada King Lovelace");
  });

  test("rejects empty, non-string and overlong names", () => {
    expect(() => normalizeName("   ")).toThrow(/Enter a name/);
    expect(() => normalizeName(undefined)).toThrow(/Enter a name/);
    expect(() => normalizeName(42)).toThrow(/Enter a name/);
    expect(() => normalizeName("x".repeat(81))).toThrow(/80 characters/);
  });
});

describe("createUser", () => {
  test("gives each person a distinct random 32-byte WebAuthn handle", () => {
    const a = createUser({ name: "A", role: "employee", actorUserId: null });
    const b = createUser({ name: "B", role: "employee", actorUserId: null });
    expect(a.webauthnUserId).not.toBe(b.webauthnUserId);
    expect(Buffer.from(a.webauthnUserId, "base64url")).toHaveLength(32);
  });
});

describe("the last active admin", () => {
  test("cannot be demoted", () => {
    const admin = createUser({ name: "Solo", role: "admin", actorUserId: null });
    expect(() => updateUserAccess({ userId: admin.id, role: "employee", actorUserId: admin.id })).toThrow(
      /only active admin/,
    );
    expect(countActiveAdmins()).toBe(1);
  });

  test("cannot be deactivated", () => {
    const admin = createUser({ name: "Solo", role: "admin", actorUserId: null });
    expect(() => updateUserAccess({ userId: admin.id, active: false, actorUserId: admin.id })).toThrow(
      /only active admin/,
    );
  });

  test("can step down once another admin exists", () => {
    const first = createUser({ name: "First", role: "admin", actorUserId: null });
    const second = createUser({ name: "Second", role: "employee", actorUserId: null });
    updateUserAccess({ userId: second.id, role: "admin", actorUserId: first.id });
    const demoted = updateUserAccess({ userId: first.id, role: "employee", actorUserId: first.id });
    expect(demoted.role).toBe("employee");
    expect(countActiveAdmins()).toBe(1);
  });

  test("an inactive admin doesn't count toward the minimum", () => {
    const first = createUser({ name: "First", role: "admin", actorUserId: null });
    const second = createUser({ name: "Second", role: "admin", actorUserId: null });
    updateUserAccess({ userId: second.id, active: false, actorUserId: first.id });
    expect(() => updateUserAccess({ userId: first.id, role: "employee", actorUserId: first.id })).toThrow(
      /only active admin/,
    );
  });
});

describe("updateUserAccess", () => {
  test("deactivating signs the person out everywhere", () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    const worker = createUser({ name: "Worker", role: "employee", actorUserId: null });
    const a = createSession({ userId: worker.id, credentialId: null, userAgent: null });
    const b = createSession({ userId: worker.id, credentialId: null, userAgent: null });

    updateUserAccess({ userId: worker.id, active: false, actorUserId: admin.id });
    // Reactivating must not resurrect the old sessions.
    updateUserAccess({ userId: worker.id, active: true, actorUserId: admin.id });
    expect(resolveSession(a.token)).toBeNull();
    expect(resolveSession(b.token)).toBeNull();
  });

  test("is audited with before and after", () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    const worker = createUser({ name: "Worker", role: "employee", actorUserId: null });
    updateUserAccess({ userId: worker.id, role: "admin", actorUserId: admin.id });
    const entry = auditFor("user", worker.id).find((e) => e.action === "access")!;
    expect(JSON.parse(entry.before_json!)).toEqual({ role: "employee", active: true });
    expect(JSON.parse(entry.after_json!)).toEqual({ role: "admin", active: true });
    expect(entry.actor_user_id).toBe(admin.id);
  });

  test("is a no-op when nothing changes", () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    updateUserAccess({ userId: admin.id, role: "admin", active: true, actorUserId: admin.id });
    expect(auditFor("user", admin.id).map((e) => e.action)).toEqual(["create"]);
  });
});

describe("renameUser / listUsers", () => {
  test("renames and lists active people first", () => {
    const admin = createUser({ name: "Zed", role: "admin", actorUserId: null });
    const gone = createUser({ name: "Aaron", role: "employee", actorUserId: null });
    createUser({ name: "bea", role: "employee", actorUserId: null });
    updateUserAccess({ userId: gone.id, active: false, actorUserId: admin.id });
    renameUser({ userId: admin.id, name: "Alice", actorUserId: admin.id });

    expect(listUsers().map((u) => u.name)).toEqual(["Alice", "bea", "Aaron"]);
    expect(listUsers()[0]?.passkeyCount).toBe(0);
  });
});
