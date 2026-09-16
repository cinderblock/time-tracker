import { beforeEach, describe, expect, test } from "bun:test";

import { auditFor } from "./audit.ts";
import { sha256Hex } from "./crypto.ts";
import { db } from "./db.server.ts";
import {
  consumeRegistration,
  findUsableRegistration,
  listOpenRegistrations,
  mintRegistration,
  registrationUrl,
  revokeRegistration,
  revokeUnusedBootstrapLinks,
} from "./registrations.ts";
import { freshDb } from "./testing/db.ts";
import { createUser, updateUserAccess } from "./users.ts";

beforeEach(freshDb);

const T0 = Date.parse("2026-09-16T12:00:00Z");
const HOUR = 3_600_000;

describe("mintRegistration", () => {
  test("stores only the token's hash, never the token", () => {
    const { token, url } = mintRegistration({ purpose: "invite", createdBy: null });
    expect(url).toBe(registrationUrl(token));
    expect(url).toBe(`http://localhost:3000/join/${token}`);

    const stored = db().query<{ token_hash: string }, []>("SELECT token_hash FROM registrations").get()!;
    expect(stored.token_hash).toBe(sha256Hex(token));
    const dump = JSON.stringify(db().query("SELECT * FROM registrations").all());
    expect(dump).not.toContain(token);
  });

  test("gives each link a distinct high-entropy token", () => {
    const a = mintRegistration({ purpose: "invite", createdBy: null }).token;
    const b = mintRegistration({ purpose: "invite", createdBy: null }).token;
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
  });

  test("bootstrap links always grant admin", () => {
    const { registration } = mintRegistration({ purpose: "bootstrap", role: "employee", createdBy: null });
    expect(registration.role).toBe("admin");
  });

  test("invites default to employee", () => {
    expect(mintRegistration({ purpose: "invite", createdBy: null }).registration.role).toBe("employee");
  });

  test("add_device links take the target's role and require an active target", () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    const worker = createUser({ name: "Worker", role: "employee", actorUserId: null });
    const { registration } = mintRegistration({ purpose: "add_device", userId: worker.id, createdBy: admin.id });
    expect(registration.role).toBe("employee");
    expect(registration.userId).toBe(worker.id);

    updateUserAccess({ userId: worker.id, active: false, actorUserId: admin.id });
    expect(() => mintRegistration({ purpose: "add_device", userId: worker.id, createdBy: admin.id })).toThrow(
      /Reactivate/,
    );
    expect(() => mintRegistration({ purpose: "add_device", userId: 999, createdBy: admin.id })).toThrow(
      /no longer exists/,
    );
  });

  test("rejects absurd lifetimes", () => {
    expect(() => mintRegistration({ purpose: "invite", createdBy: null, ttlMs: 0 })).toThrow();
    expect(() => mintRegistration({ purpose: "invite", createdBy: null, ttlMs: 365 * 24 * HOUR })).toThrow();
  });

  test("is audited without the token", () => {
    const { token, registration } = mintRegistration({ purpose: "invite", nameHint: "Bob", createdBy: null });
    const [entry] = auditFor("registration", registration.id);
    expect(entry?.action).toBe("mint");
    expect(entry?.after_json).toContain("Bob");
    expect(entry?.after_json).not.toContain(token);
  });
});

describe("findUsableRegistration", () => {
  test("honours expiry", () => {
    const { token } = mintRegistration({ purpose: "invite", createdBy: null, ttlMs: HOUR, now: T0 });
    expect(findUsableRegistration(token, T0 + HOUR - 1)).not.toBeNull();
    expect(findUsableRegistration(token, T0 + HOUR)).toBeNull();
  });

  test("rejects revoked, used and unknown tokens", () => {
    const revoked = mintRegistration({ purpose: "invite", createdBy: null });
    revokeRegistration({ id: revoked.registration.id, actorUserId: null });
    expect(findUsableRegistration(revoked.token)).toBeNull();

    const used = mintRegistration({ purpose: "invite", createdBy: null });
    const user = createUser({ name: "U", role: "employee", actorUserId: null });
    expect(consumeRegistration({ id: used.registration.id, userId: user.id })).toBe(true);
    expect(findUsableRegistration(used.token)).toBeNull();

    expect(findUsableRegistration("not-a-real-token")).toBeNull();
    expect(findUsableRegistration("")).toBeNull();
  });
});

describe("bootstrap links", () => {
  test("stop working as soon as any admin exists", () => {
    const { token } = mintRegistration({ purpose: "bootstrap", createdBy: null });
    expect(findUsableRegistration(token)).not.toBeNull();
    createUser({ name: "Someone", role: "admin", actorUserId: null });
    expect(findUsableRegistration(token)).toBeNull();
  });

  test("work again only if no active admin remains", () => {
    // Recovery path: every admin deactivated (possible only via the database).
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    const { token } = mintRegistration({ purpose: "bootstrap", createdBy: null });
    expect(findUsableRegistration(token)).toBeNull();
    db().query("UPDATE users SET active = 0 WHERE id = ?").run(admin.id);
    expect(findUsableRegistration(token)).not.toBeNull();
  });

  test("admin invites are unaffected", () => {
    createUser({ name: "Admin", role: "admin", actorUserId: null });
    const { token } = mintRegistration({ purpose: "invite", role: "admin", createdBy: null });
    expect(findUsableRegistration(token)).not.toBeNull();
  });
});

describe("consumeRegistration", () => {
  test("succeeds exactly once and records who used it", () => {
    const { registration } = mintRegistration({ purpose: "invite", createdBy: null });
    const user = createUser({ name: "U", role: "employee", actorUserId: null });
    expect(consumeRegistration({ id: registration.id, userId: user.id })).toBe(true);
    expect(consumeRegistration({ id: registration.id, userId: user.id })).toBe(false);
    const row = db()
      .query<{ user_id: number }, [number]>("SELECT user_id FROM registrations WHERE id = ?")
      .get(registration.id)!;
    expect(row.user_id).toBe(user.id);
  });

  test("refuses an expired link even if nobody looked it up first", () => {
    const { registration } = mintRegistration({ purpose: "invite", createdBy: null, ttlMs: HOUR, now: T0 });
    const user = createUser({ name: "U", role: "employee", actorUserId: null });
    expect(consumeRegistration({ id: registration.id, userId: user.id, now: T0 + 2 * HOUR })).toBe(false);
  });

  test("never overwrites an add_device link's target", () => {
    const worker = createUser({ name: "Worker", role: "employee", actorUserId: null });
    const other = createUser({ name: "Other", role: "employee", actorUserId: null });
    const { registration } = mintRegistration({ purpose: "add_device", userId: worker.id, createdBy: null });
    consumeRegistration({ id: registration.id, userId: other.id });
    const row = db()
      .query<{ user_id: number }, [number]>("SELECT user_id FROM registrations WHERE id = ?")
      .get(registration.id)!;
    expect(row.user_id).toBe(worker.id);
  });
});

describe("bootstrap link housekeeping", () => {
  test("revokeUnusedBootstrapLinks leaves invites alone", () => {
    const bootstrap = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const invite = mintRegistration({ purpose: "invite", createdBy: null });
    expect(revokeUnusedBootstrapLinks()).toBe(1);
    expect(findUsableRegistration(bootstrap.token)).toBeNull();
    expect(findUsableRegistration(invite.token)).not.toBeNull();
    expect(revokeUnusedBootstrapLinks()).toBe(0);
  });
});

describe("listOpenRegistrations", () => {
  test("lists only usable links, newest first, with names attached", () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    const worker = createUser({ name: "Worker", role: "employee", actorUserId: null });
    mintRegistration({ purpose: "invite", nameHint: "Old", createdBy: admin.id, now: Date.now() - 1000 });
    mintRegistration({ purpose: "add_device", userId: worker.id, createdBy: admin.id });
    const dead = mintRegistration({ purpose: "invite", createdBy: admin.id });
    revokeRegistration({ id: dead.registration.id, actorUserId: admin.id });

    const open = listOpenRegistrations();
    expect(open.map((r) => r.purpose)).toEqual(["add_device", "invite"]);
    expect(open[0]?.targetName).toBe("Worker");
    expect(open[0]?.createdByName).toBe("Admin");
    expect(open[1]?.nameHint).toBe("Old");
  });
});
