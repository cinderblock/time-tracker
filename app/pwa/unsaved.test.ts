import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { watchUnsavedText } from "./unsaved.ts";

/**
 * The watcher against a pretend page: just enough of the DOM for it — text
 * fields with values, forms that contain them, events, focus. The real thing
 * is exercised in a browser by the e2e tests.
 */

class FakeElement {
  parent: FakeElement | null = null;
  attrs = new Set<string>();
  isConnected = true;
  closest(selector: string): FakeElement | null {
    const attr = selector.replace(/^\[|\]$/g, "");
    for (let el: FakeElement | null = this; el; el = el.parent) if (el.attrs.has(attr)) return el;
    return null;
  }
  contains(other: FakeElement): boolean {
    for (let el: FakeElement | null = other; el; el = el.parent) if (el === this) return true;
    return false;
  }
}
class FakeInput extends FakeElement {
  type = "text";
  value = "";
  readOnly = false;
  disabled = false;
}
class FakeTextArea extends FakeInput {}

const g = globalThis as Record<string, unknown>;
beforeAll(() => {
  g.HTMLInputElement = FakeInput;
  g.HTMLTextAreaElement = FakeTextArea;
});
afterAll(() => {
  delete g.HTMLInputElement;
  delete g.HTMLTextAreaElement;
});

function page() {
  const listeners = new Map<string, ((e: { target: unknown }) => void)[]>();
  const doc = {
    activeElement: null as unknown,
    addEventListener: (type: string, fn: (e: { target: unknown }) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const fire = (type: string, target: unknown) => listeners.get(type)?.forEach((fn) => fn({ target }));
  const watcher = watchUnsavedText(doc as unknown as Document);
  const field = (opts: { in?: FakeElement; draft?: boolean } = {}) => {
    const el = new FakeInput();
    el.parent = opts.in ?? null;
    if (opts.draft) el.attrs.add("data-draft");
    return el;
  };
  const type = (el: FakeInput, text: string) => {
    el.value = text;
    fire("input", el);
  };
  return { doc, fire, watcher, field, type };
}

describe("would a reload lose typed text?", () => {
  test("text typed into a field that keeps no draft is at risk until it's saved", () => {
    const p = page();
    const form = new FakeElement();
    const name = p.field({ in: form });
    expect(p.watcher.textAtRisk()).toBe(false);
    p.type(name, "Crew Hours");
    expect(p.watcher.textAtRisk()).toBe(true);
    p.fire("submit", form);
    expect(p.watcher.textAtRisk()).toBe(false);
  });

  test("emptied, reset, or gone from the page: nothing at risk", () => {
    const p = page();
    const form = new FakeElement();
    const a = p.field({ in: form });
    const b = p.field();
    const c = p.field();
    p.type(a, "x");
    p.type(b, "y");
    p.type(c, "z");
    p.fire("reset", form);
    p.type(b, "");
    c.isConnected = false;
    expect(p.watcher.textAtRisk()).toBe(false);
  });

  test("fields that keep their own draft come back, so they're safe — except while being typed in", () => {
    const p = page();
    const dialog = new FakeElement();
    dialog.attrs.add("data-draft");
    const inDialog = p.field({ in: dialog });
    const own = p.field({ draft: true });
    p.type(inDialog, "Paperwork");
    p.type(own, "Framing");
    expect(p.watcher.textAtRisk()).toBe(false);

    p.doc.activeElement = own;
    expect(p.watcher.typing()).toBe(true);
    own.value = "";
    expect(p.watcher.typing()).toBe(false);
  });

  test("read-only, disabled and non-text fields aren't typing", () => {
    const p = page();
    const ro = p.field();
    ro.readOnly = true;
    ro.value = "x";
    p.doc.activeElement = ro;
    expect(p.watcher.typing()).toBe(false);
    const box = p.field();
    box.type = "checkbox";
    p.type(box, "on");
    expect(p.watcher.textAtRisk()).toBe(false);
  });
});
