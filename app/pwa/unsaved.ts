/**
 * Would reloading the page now lose something someone typed?
 *
 * Watches the whole page rather than asking each form: any text field typed
 * into is remembered until its form is submitted or reset, or it's emptied,
 * or it leaves the page. Fields that keep their own draft (`data-draft`, see
 * app/drafts/) are safe to reload over — they come back — except while
 * they're being typed in: yanking the page out from under someone mid-word is
 * its own kind of loss.
 */

type TextField = HTMLInputElement | HTMLTextAreaElement;

const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "number", "time", "date", ""]);

export function isTextField(el: unknown): el is TextField {
  if (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement) {
    return TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  }
  return false;
}

/** Keeps its own draft, and comes back after a reload. */
const keepsDraft = (el: Element) => el.closest("[data-draft]") != null;

export interface UnsavedWatcher {
  /** Text that a reload would lose: typed and unsaved, in a field with no draft. */
  textAtRisk(): boolean;
  /** Someone is typing: a text field has focus and something in it. */
  typing(): boolean;
  stop(): void;
}

export function watchUnsavedText(doc: Document = document): UnsavedWatcher {
  const edited = new Set<TextField>();

  const onInput = (e: Event) => {
    const t = e.target;
    if (!isTextField(t)) return;
    if (t.value === "") edited.delete(t);
    else edited.add(t);
  };
  const onFormDone = (e: Event) => {
    const form = e.target as HTMLFormElement | null;
    if (!form) return;
    for (const el of edited) if (form.contains(el)) edited.delete(el);
  };

  doc.addEventListener("input", onInput, true);
  doc.addEventListener("submit", onFormDone, true);
  doc.addEventListener("reset", onFormDone, true);

  return {
    textAtRisk() {
      for (const el of [...edited]) {
        if (!el.isConnected || el.value === "") {
          edited.delete(el);
          continue;
        }
        if (!keepsDraft(el)) return true;
      }
      return false;
    },
    typing() {
      const active = doc.activeElement;
      return isTextField(active) && active.value !== "";
    },
    stop() {
      doc.removeEventListener("input", onInput, true);
      doc.removeEventListener("submit", onFormDone, true);
      doc.removeEventListener("reset", onFormDone, true);
    },
  };
}
