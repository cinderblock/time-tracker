import { beforeEach, describe, expect, test } from "bun:test";

import { finishEnrollment, finishSignIn, startEnrollment, startSignIn } from "./auth-flows.ts";
import { listCredentials, removeCredential } from "./credentials.ts";
import { db } from "./db.server.ts";
import { findUsableRegistration, mintRegistration } from "./registrations.ts";
import { resolveSession } from "./sessions.ts";
import { freshDb } from "./testing/db.ts";
import { SoftAuthenticator } from "./testing/soft-authenticator.ts";
import { countActiveAdmins, createUser, getUser, updateUserAccess } from "./users.ts";
import { rpParams } from "./webauthn.ts";

const ORIGIN = rpParams().origin;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

beforeEach(freshDb);

/** Run a whole link-based enrollment with a fresh software passkey. */
async function enrollWithLink(token: string, name = "Ada Lovelace") {
  const authenticator = new SoftAuthenticator(ORIGIN);
  const { ceremonyId, options } = await startEnrollment({ joinToken: token, currentUser: null, name });
  const result = await finishEnrollment({
    ceremonyId,
    response: authenticator.register(options),
    userAgent: UA,
  });
  return { authenticator, result };
}

async function signIn(authenticator: SoftAuthenticator) {
  const { ceremonyId, options } = await startSignIn();
  return finishSignIn({ ceremonyId, response: authenticator.authenticate(options), userAgent: UA });
}

describe("first-admin bootstrap", () => {
  test("creates an admin, stores the passkey, consumes the link and signs them in", async () => {
    const { token } = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const { result } = await enrollWithLink(token, "  First   Admin ");

    expect(result.user.role).toBe("admin");
    expect(result.user.name).toBe("First Admin");
    expect(countActiveAdmins()).toBe(1);
    expect(result.credential.nickname).toBe("iPhone · Safari");
    expect(listCredentials(result.user.id)).toHaveLength(1);
    expect(findUsableRegistration(token)).toBeNull();

    expect(result.sessionToken).toBeString();
    expect(resolveSession(result.sessionToken)?.user.id).toBe(result.user.id);
  });

  test("records the registering passkey as used, since it signed them in", async () => {
    const { token } = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const { result } = await enrollWithLink(token);
    expect(listCredentials(result.user.id)[0]?.lastUsedAt).toBeNumber();
  });

  test("finishing setup revokes every other setup link", async () => {
    const first = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const leftover = mintRegistration({ purpose: "bootstrap", createdBy: null });
    await enrollWithLink(first.token);
    expect(findUsableRegistration(leftover.token)).toBeNull();
    const row = db()
      .query<{ revoked_at: number | null }, [number]>("SELECT revoked_at FROM registrations WHERE id = ?")
      .get(leftover.registration.id)!;
    expect(row.revoked_at).toBeNumber();
  });

  test("two setup links completed at once produce exactly one admin", async () => {
    // Both ceremonies start while no admin exists, so both pass the start-time
    // check. The finish-time check inside the transaction must stop the second.
    const a = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const b = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const phoneA = new SoftAuthenticator(ORIGIN);
    const phoneB = new SoftAuthenticator(ORIGIN);
    const startA = await startEnrollment({ joinToken: a.token, currentUser: null, name: "Admin A" });
    const startB = await startEnrollment({ joinToken: b.token, currentUser: null, name: "Admin B" });

    await finishEnrollment({ ceremonyId: startA.ceremonyId, response: phoneA.register(startA.options), userAgent: UA });
    await expect(
      finishEnrollment({ ceremonyId: startB.ceremonyId, response: phoneB.register(startB.options), userAgent: UA }),
    ).rejects.toThrow(/already been used/);
    expect(countActiveAdmins()).toBe(1);
  });

  test("the passkey signs the admin back in", async () => {
    const { token } = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const { authenticator, result } = await enrollWithLink(token);

    const signedIn = await signIn(authenticator);
    expect(signedIn.ok).toBe(true);
    if (!signedIn.ok) return;
    expect(signedIn.user.id).toBe(result.user.id);
    expect(resolveSession(signedIn.sessionToken)?.user.id).toBe(result.user.id);
  });
});

describe("one-time links", () => {
  test("an invite creates a person with the role the admin chose", async () => {
    const { token } = mintRegistration({ purpose: "invite", role: "employee", createdBy: null });
    const { result } = await enrollWithLink(token, "Grace Hopper");
    expect(result.user.role).toBe("employee");
    expect(result.user.name).toBe("Grace Hopper");
  });

  test("a link cannot be used twice", async () => {
    const { token } = mintRegistration({ purpose: "invite", createdBy: null });
    await enrollWithLink(token);
    await expect(enrollWithLink(token)).rejects.toThrow(/expired or has already been used/);
  });

  test("racing the same link in two tabs creates exactly one person", async () => {
    // Both tabs pass the "is the link usable?" check at start, before either
    // finishes. The second finish must roll back entirely — including the
    // person it had already inserted inside the transaction.
    const { token } = mintRegistration({ purpose: "invite", createdBy: null });
    const tabA = new SoftAuthenticator(ORIGIN);
    const tabB = new SoftAuthenticator(ORIGIN);
    const startA = await startEnrollment({ joinToken: token, currentUser: null, name: "Tab A" });
    const startB = await startEnrollment({ joinToken: token, currentUser: null, name: "Tab B" });

    await finishEnrollment({ ceremonyId: startA.ceremonyId, response: tabA.register(startA.options), userAgent: UA });
    await expect(
      finishEnrollment({ ceremonyId: startB.ceremonyId, response: tabB.register(startB.options), userAgent: UA }),
    ).rejects.toThrow(/already been used/);

    const names = db().query<{ name: string }, []>("SELECT name FROM users").all().map((r) => r.name);
    expect(names).toEqual(["Tab A"]);
    expect(db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM credentials").get()!.n).toBe(1);
  });

  test("abandoning the passkey prompt does not burn the link", async () => {
    const { token } = mintRegistration({ purpose: "invite", createdBy: null });
    await startEnrollment({ joinToken: token, currentUser: null, name: "Someone" });
    // ...the person cancels Face ID; no finish call ever arrives.
    expect(findUsableRegistration(token)).not.toBeNull();
  });

  test("a new person must give a name", async () => {
    const { token } = mintRegistration({ purpose: "invite", createdBy: null });
    await expect(startEnrollment({ joinToken: token, currentUser: null, name: "   " })).rejects.toThrow(
      /Enter a name/,
    );
  });

  test("an add_device link adds a passkey to the existing person", async () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    const worker = createUser({ name: "Worker", role: "employee", actorUserId: null });
    const { token } = mintRegistration({ purpose: "add_device", userId: worker.id, createdBy: admin.id });

    const { authenticator, result } = await enrollWithLink(token, "ignored for add_device");
    expect(result.user.id).toBe(worker.id);
    expect(result.user.name).toBe("Worker");
    expect(listCredentials(worker.id)).toHaveLength(1);
    expect((await signIn(authenticator)).ok).toBe(true);
  });

  test("an add_device link dies with its person's deactivation", async () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    const worker = createUser({ name: "Worker", role: "employee", actorUserId: null });
    const { token } = mintRegistration({ purpose: "add_device", userId: worker.id, createdBy: admin.id });
    updateUserAccess({ userId: worker.id, active: false, actorUserId: admin.id });
    await expect(enrollWithLink(token)).rejects.toThrow(/expired or has already been used/);
  });
});

describe("adding a passkey while signed in", () => {
  test("adds to the current person without minting a new session", async () => {
    const { token } = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const { result } = await enrollWithLink(token);

    const second = new SoftAuthenticator(ORIGIN);
    const { ceremonyId, options } = await startEnrollment({
      joinToken: null,
      currentUser: result.user,
      name: null,
    });
    // The first passkey is excluded so the same authenticator isn't enrolled twice.
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([result.credential.credentialId]);

    const added = await finishEnrollment({ ceremonyId, response: second.register(options), userAgent: null });
    expect(added.user.id).toBe(result.user.id);
    expect(added.sessionToken).toBeNull();
    expect(added.credential.nickname).toBe("This device");
    expect(listCredentials(result.user.id)).toHaveLength(2);
  });

  test("is refused when neither signed in nor holding a link", async () => {
    await expect(startEnrollment({ joinToken: null, currentUser: null, name: "x" })).rejects.toThrow(/Sign in first/);
  });
});

describe("ceremonies", () => {
  test("are single-use", async () => {
    const { token } = mintRegistration({ purpose: "invite", createdBy: null });
    const authenticator = new SoftAuthenticator(ORIGIN);
    const { ceremonyId, options } = await startEnrollment({ joinToken: token, currentUser: null, name: "A" });
    const response = authenticator.register(options);
    await finishEnrollment({ ceremonyId, response, userAgent: UA });
    await expect(finishEnrollment({ ceremonyId, response, userAgent: UA })).rejects.toThrow(/took too long/);
  });

  test("reject a response to a different challenge", async () => {
    const { token } = mintRegistration({ purpose: "invite", createdBy: null });
    const authenticator = new SoftAuthenticator(ORIGIN);
    const first = await startEnrollment({ joinToken: token, currentUser: null, name: "A" });
    const second = await startEnrollment({ joinToken: token, currentUser: null, name: "A" });
    // Answer the first challenge, but present it under the second ceremony.
    await expect(
      finishEnrollment({ ceremonyId: second.ceremonyId, response: authenticator.register(first.options), userAgent: UA }),
    ).rejects.toThrow(/couldn't be verified/);
  });

  test("reject a response from the wrong origin", async () => {
    const { token } = mintRegistration({ purpose: "invite", createdBy: null });
    const phishing = new SoftAuthenticator("https://evil.example");
    const { ceremonyId, options } = await startEnrollment({ joinToken: token, currentUser: null, name: "A" });
    await expect(
      finishEnrollment({ ceremonyId, response: phishing.register(options), userAgent: UA }),
    ).rejects.toThrow(/couldn't be verified/);
    // A failed verification must not consume the link.
    expect(findUsableRegistration(token)).not.toBeNull();
  });
});

describe("sign-in", () => {
  test("an unknown passkey is reported so the client can signal its removal", async () => {
    const stranger = new SoftAuthenticator(ORIGIN);
    const result = await signIn(stranger);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unknownCredential).toEqual({ rpID: "localhost", credentialID: stranger.id });
  });

  test("a passkey removed by an admin stops working", async () => {
    const { token: bootstrap } = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const { result: admin } = await enrollWithLink(bootstrap, "Admin");
    const { token } = mintRegistration({ purpose: "invite", createdBy: admin.user.id });
    const { authenticator, result: worker } = await enrollWithLink(token, "Worker");

    removeCredential({ id: worker.credential.id, userId: worker.user.id, actorUserId: admin.user.id });
    const attempt = await signIn(authenticator);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.unknownCredential?.credentialID).toBe(authenticator.id);
  });

  test("a deactivated person cannot sign in", async () => {
    const { token: bootstrap } = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const { result: admin } = await enrollWithLink(bootstrap, "Admin");
    const { token } = mintRegistration({ purpose: "invite", createdBy: admin.user.id });
    const { authenticator, result: worker } = await enrollWithLink(token, "Worker");

    updateUserAccess({ userId: worker.user.id, active: false, actorUserId: admin.user.id });
    const attempt = await signIn(authenticator);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.message).toMatch(/deactivated/);
    expect(getUser(worker.user.id)?.active).toBe(false);
  });

  test("records the new signature counter", async () => {
    const { token } = mintRegistration({ purpose: "bootstrap", createdBy: null });
    const { authenticator, result } = await enrollWithLink(token);
    await signIn(authenticator);
    await signIn(authenticator);
    const [credential] = listCredentials(result.user.id);
    expect(credential?.counter).toBe(2);
    expect(credential?.lastUsedAt).toBeNumber();
  });
});
