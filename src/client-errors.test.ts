import { beforeEach, describe, expect, test } from "bun:test";

import type { ClientError } from "./bug-schema.ts";
import {
  EVENTS_PER_GROUP,
  EVENTS_PER_WINDOW,
  fingerprintOf,
  getErrorGroup,
  listErrorGroups,
  normalizeMessage,
  openErrorGroupIds,
  recordClientErrors,
  resetRateLimits,
  setErrorGroupStatus,
  topFrames,
} from "./client-errors.ts";
import { freshDb } from "./testing/db.ts";
import { createUser } from "./users.ts";

const NOW = Date.parse("2026-10-05T20:00:00Z");

const CHROME = `TypeError: Cannot read properties of undefined (reading 'id')
    at JobSection (https://time.example/assets/NotesPanel-B3kq9Zx1.js:12:345)
    at renderWithHooks (https://time.example/assets/chunk-DkLp02aA.js:1:2)
    at async Object.flush (https://time.example/assets/root-Qq8m1Y2b.js:9:9)`;
const SAFARI = `JobSection@https://time.example/assets/NotesPanel-Zz9q0a1B.js:40:12
renderWithHooks@https://time.example/assets/chunk-DkLp02aA.js:1:2`;

const err = (over: Partial<ClientError> = {}): ClientError => ({
  message: "Cannot read properties of undefined (reading 'id')",
  name: "TypeError",
  stack: CHROME,
  source: "error",
  at: NOW - 1000,
  repeats: 1,
  url: "https://time.example/day/2026-10-01",
  revision: "abc",
  breadcrumbs: [{ at: NOW - 2000, kind: "click", text: "Turn 2 notes into hours" }],
  ...over,
});

let alice = 0;
beforeEach(() => {
  freshDb();
  resetRateLimits();
  alice = createUser({ name: "Alice", role: "employee", actorUserId: null }).id;
});

const record = (errors: ClientError[], userId: number | null = alice, now = NOW) =>
  recordClientErrors({ errors, userId, sender: userId ? `user:${userId}` : "signed-out", userAgent: "Test", now });

describe("fingerprints", () => {
  test("what varies between occurrences is taken out of the message", () => {
    expect(normalizeMessage("Entry 01a0cb50-0182-76a2-af83-dfa7eff4800f failed after 3 tries (code 0x1f)")).toBe(
      "Entry <id> failed after <n> tries (code <n>)",
    );
    expect(normalizeMessage("Failed to load script https://time.example/assets/x-1.js")).toBe("Failed to load script <url>");
  });

  test("stack frames are named by function and file, without the build's hash or the line", () => {
    expect(topFrames(CHROME)).toEqual(["JobSection@NotesPanel", "renderWithHooks@chunk", "Object.flush@root"]);
    expect(topFrames(SAFARI)).toEqual(["JobSection@NotesPanel", "renderWithHooks@chunk"]);
    expect(topFrames(undefined)).toEqual([]);
  });

  test("the same fault on another build, or with other numbers, is the same group; another fault isn't", () => {
    const a = fingerprintOf(err());
    expect(fingerprintOf(err({ stack: CHROME.replace("B3kq9Zx1", "Other123").replace(":12:345", ":99:1") }))).toBe(a);
    expect(fingerprintOf(err({ message: "Cannot read properties of undefined (reading 'name')" }))).not.toBe(a);
    expect(fingerprintOf(err({ stack: CHROME.replace("JobSection", "NoteRow") }))).not.toBe(a);
  });
});

describe("recording", () => {
  test("occurrences are grouped and counted, with who and their breadcrumbs", () => {
    const first = record([err()]);
    expect(first).toMatchObject({ stored: 1, dropped: 0 });
    expect(first.fresh).toHaveLength(1);
    const again = record([err({ repeats: 4 })], null);
    expect(again.fresh).toEqual([]);

    const [group] = listErrorGroups();
    expect(group).toMatchObject({ count: 5, status: "new", people: ["Alice"], signedOut: true });
    expect(group!.message).toBe("TypeError: Cannot read properties of undefined (reading 'id')");
    const detail = getErrorGroup(group!.id)!;
    expect(detail.events).toHaveLength(2);
    expect(detail.events[1]).toMatchObject({ userName: "Alice", clientRevision: "abc", userAgent: "Test" });
    expect(detail.events[1]!.detail.breadcrumbs).toEqual([{ at: NOW - 2000, kind: "click", text: "Turn 2 notes into hours" }]);
  });

  test("a group marked fixed that happens again is open again, and counts as new", () => {
    const { fresh } = record([err()]);
    setErrorGroupStatus({ id: fresh[0]!, status: "fixed", actorUserId: alice, now: NOW });
    expect(openErrorGroupIds()).toEqual([]);
    expect(record([err()], alice, NOW + 1000).fresh).toEqual(fresh);
    expect(listErrorGroups()[0]).toMatchObject({ status: "new", regressedAt: NOW + 1000 });
    // Ignored stays ignored.
    setErrorGroupStatus({ id: fresh[0]!, status: "ignored", actorUserId: alice, now: NOW });
    expect(record([err()], alice, NOW + 2000).fresh).toEqual([]);
    expect(listErrorGroups()[0]!.status).toBe("ignored");
  });

  test("only the latest occurrences are kept; the count keeps going", () => {
    for (let i = 0; i < EVENTS_PER_GROUP + 5; i++) record([err()], alice, NOW + i);
    const group = getErrorGroup(listErrorGroups()[0]!.id)!;
    expect(group.count).toBe(EVENTS_PER_GROUP + 5);
    expect(group.events).toHaveLength(EVENTS_PER_GROUP);
  });

  test("past the rate limit, occurrences are counted but not stored", () => {
    const batch = Array.from({ length: 20 }, () => err());
    let dropped = 0;
    for (let i = 0; i < EVENTS_PER_WINDOW / 20 + 1; i++) dropped += record(batch).dropped;
    expect(dropped).toBe(20);
    expect(listErrorGroups()[0]!.count).toBe(EVENTS_PER_WINDOW + 20);
  });
});
