import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DRAFT_MAX_AGE_MS, clearDrafts, draftKey, readDraft, removeDraft, writeDraft } from "./drafts.ts";

/** A localStorage for the tests (there is no window here). */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const g = globalThis as unknown as { window?: { localStorage: Storage } };

beforeEach(() => {
  g.window = { localStorage: memoryStorage() };
});
afterEach(() => {
  delete g.window;
});

describe("drafts", () => {
  test("kept per person and field, and read back", () => {
    writeDraft(draftKey("7", "note-box:2026-10-03:job"), "Framing the north wall", 1_000);
    expect(readDraft<string>(draftKey("7", "note-box:2026-10-03:job"), 2_000)).toBe("Framing the north wall");
    expect(readDraft(draftKey("8", "note-box:2026-10-03:job"), 2_000)).toBeUndefined();
    writeDraft(draftKey("7", "entry-editor:new"), { note: "x", duration: "1:30" }, 1_000);
    expect(readDraft<object>(draftKey("7", "entry-editor:new"), 2_000)).toEqual({ note: "x", duration: "1:30" });
  });

  test("older than a week, a draft is dropped", () => {
    const key = draftKey("7", "f");
    writeDraft(key, "old", 1_000);
    expect(readDraft(key, 1_000 + DRAFT_MAX_AGE_MS + 1)).toBeUndefined();
    expect(g.window!.localStorage.getItem(key)).toBeNull();
  });

  test("garbage in storage reads as no draft", () => {
    g.window!.localStorage.setItem(draftKey("7", "f"), "{not json");
    expect(readDraft(draftKey("7", "f"))).toBeUndefined();
  });

  test("removed one at a time, by person, or all at once (signing out)", () => {
    writeDraft(draftKey("7", "a"), "a");
    writeDraft(draftKey("7", "b"), "b");
    writeDraft(draftKey("8", "a"), "c");
    g.window!.localStorage.setItem("something-else", "kept");
    removeDraft(draftKey("7", "a"));
    expect(readDraft(draftKey("7", "a"))).toBeUndefined();
    clearDrafts("7");
    expect(readDraft(draftKey("7", "b"))).toBeUndefined();
    expect(readDraft<string>(draftKey("8", "a"))).toBe("c");
    clearDrafts();
    expect(readDraft(draftKey("8", "a"))).toBeUndefined();
    expect(g.window!.localStorage.getItem("something-else")).toBe("kept");
  });

  test("with no storage at all (privacy modes), nothing breaks", () => {
    delete g.window;
    writeDraft(draftKey("7", "a"), "a");
    expect(readDraft(draftKey("7", "a"))).toBeUndefined();
    clearDrafts();
  });
});
