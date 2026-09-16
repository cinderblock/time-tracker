import { beforeEach, describe, expect, test } from "bun:test";

import {
  addCredential,
  findCredentialForVerification,
  listCredentials,
  removeCredential,
  renameCredential,
} from "./credentials.ts";
import { freshDb } from "./testing/db.ts";
import { createUser } from "./users.ts";

beforeEach(freshDb);

let seq = 0;
function passkey(userId: number, nickname = "Phone") {
  seq += 1;
  return addCredential({
    userId,
    credentialId: `cred-${seq}`,
    publicKey: new Uint8Array([1, 2, 3, seq]),
    counter: 0,
    transports: ["internal", "hybrid"],
    deviceType: "multiDevice",
    backedUp: true,
    nickname,
  });
}

describe("credentials", () => {
  test("round-trips the public key and transports", () => {
    const user = createUser({ name: "U", role: "employee", actorUserId: null });
    const created = passkey(user.id);
    const found = findCredentialForVerification(created.credentialId)!;
    expect([...found.publicKey]).toEqual([1, 2, 3, seq]);
    expect(found.transports).toEqual(["internal", "hybrid"]);
    expect(found.backedUp).toBe(true);
    // The public key is only exposed by the verification lookup.
    expect("publicKey" in listCredentials(user.id)[0]!).toBe(false);
  });

  test("a person cannot remove their own last passkey", () => {
    const user = createUser({ name: "U", role: "employee", actorUserId: null });
    const only = passkey(user.id);
    expect(() => removeCredential({ id: only.id, userId: user.id, actorUserId: user.id })).toThrow(
      /lock you out/,
    );

    const second = passkey(user.id, "Laptop");
    removeCredential({ id: only.id, userId: user.id, actorUserId: user.id });
    expect(listCredentials(user.id).map((c) => c.id)).toEqual([second.id]);
  });

  test("an admin can remove someone's last passkey (the lost-phone case)", () => {
    const admin = createUser({ name: "A", role: "admin", actorUserId: null });
    const user = createUser({ name: "U", role: "employee", actorUserId: null });
    const only = passkey(user.id);
    removeCredential({ id: only.id, userId: user.id, actorUserId: admin.id });
    expect(listCredentials(user.id)).toEqual([]);
  });

  test("cannot act on another person's passkey by id", () => {
    const a = createUser({ name: "A", role: "employee", actorUserId: null });
    const b = createUser({ name: "B", role: "employee", actorUserId: null });
    const aKey = passkey(a.id);
    passkey(b.id);
    passkey(b.id);
    expect(() => removeCredential({ id: aKey.id, userId: b.id, actorUserId: b.id })).toThrow(/no longer exists/);
    expect(() => renameCredential({ id: aKey.id, userId: b.id, nickname: "x", actorUserId: b.id })).toThrow(
      /no longer exists/,
    );
    expect(listCredentials(a.id)).toHaveLength(1);
  });

  test("rename trims and caps the nickname", () => {
    const user = createUser({ name: "U", role: "employee", actorUserId: null });
    const key = passkey(user.id);
    renameCredential({ id: key.id, userId: user.id, nickname: `  Work   ${"y".repeat(100)}`, actorUserId: user.id });
    const renamed = listCredentials(user.id)[0]!;
    expect(renamed.nickname.startsWith("Work y")).toBe(true);
    expect(renamed.nickname).toHaveLength(60);
    expect(() => renameCredential({ id: key.id, userId: user.id, nickname: "  ", actorUserId: user.id })).toThrow();
  });
});
