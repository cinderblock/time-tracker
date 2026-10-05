import { notificationsStore } from "@mantine/notifications";

import type { Breadcrumb } from "../../src/bug-schema.ts";

/**
 * Breadcrumbs: what happened in this tab just before something went wrong —
 * where the person went, what they pressed, which changes were made and what
 * the server said, what the app told them, what failed.
 *
 * Never what they typed: a click is recorded by the control's name ("Turn 2
 * notes into hours"), a field only by its label. The screen's own data goes
 * in a report separately, on purpose.
 *
 * Kept in sessionStorage, so an update's reload or a crash doesn't wipe the
 * trail that led to it.
 */

const MAX = 100;
const KEY = "tt-breadcrumbs";

let crumbs: Breadcrumb[] | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function all(): Breadcrumb[] {
  if (crumbs) return crumbs;
  crumbs = [];
  try {
    const raw = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(KEY) : null;
    if (raw) crumbs = (JSON.parse(raw) as Breadcrumb[]).slice(-MAX);
  } catch {
    // unreadable: start fresh
  }
  return crumbs;
}

function persist(): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(all()));
  } catch {
    // full or blocked: the trail just won't survive a reload
  }
}

/** Record something that happened. Cheap; safe to call anywhere in the browser. */
export function addCrumb(kind: string, text: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const list = all();
  list.push({ at: Date.now(), kind, text: text.slice(0, 500), ...(data ? { data } : {}) });
  if (list.length > MAX) list.splice(0, list.length - MAX);
  persistTimer ??= setTimeout(() => {
    persistTimer = null;
    persist();
  }, 500);
}

/** The latest `n`, oldest first. */
export function recentCrumbs(n = MAX): Breadcrumb[] {
  return all().slice(-n);
}

/** A control's name as a person would say it — never a field's contents. */
export function controlName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const label = el.labels?.[0]?.textContent?.trim() || el.getAttribute("placeholder") || el.name || el.type;
    return label;
  }
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** The words in a toast's title or message, whether it's a string or a little tree of elements. */
function textOf(node: unknown, depth = 0): string {
  if (node == null || typeof node === "boolean" || depth > 6) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n, depth + 1)).filter(Boolean).join(" ");
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: unknown } }).props?.children, depth + 1);
  }
  return "";
}

const CLICKABLE =
  'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], input[type="checkbox"], input[type="radio"], summary, label';

let installed = false;

/** Start recording clicks, connectivity and visibility. Once per page. */
export function installBreadcrumbs(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target.closest(CLICKABLE) : null;
      if (!target) return;
      const name = controlName(target);
      const role = target.getAttribute("role") ?? target.tagName.toLowerCase();
      const data: Record<string, unknown> = { role };
      if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) data.checked = target.checked;
      if (target instanceof HTMLAnchorElement) data.href = target.getAttribute("href");
      // Which part of the screen: the nearest labelled group or dialog.
      const region = target.closest('[role="dialog"], [role="group"][aria-label], [role="alert"], nav, header');
      if (region) data.in = region.getAttribute("aria-label") ?? region.tagName.toLowerCase();
      addCrumb("click", name || `(${role} with no name)`, data);
    },
    { capture: true },
  );
  // What the app told the person, in its toasts: each one the first time it's seen.
  const seen = new Set<string>();
  notificationsStore.subscribe((state) => {
    for (const n of [...state.notifications, ...state.queue]) {
      if (!n.id || seen.has(n.id)) continue;
      seen.add(n.id);
      const text = [textOf(n.title), textOf(n.message)].filter(Boolean).join(": ");
      addCrumb("toast", text || "(a notice)", n.color ? { color: n.color } : undefined);
    }
  });

  window.addEventListener("online", () => addCrumb("online", "Connection back"));
  window.addEventListener("offline", () => addCrumb("online", "Connection lost"));
  document.addEventListener("visibilitychange", () => addCrumb("visibility", document.visibilityState));
  window.addEventListener("pagehide", () => {
    addCrumb("visibility", "Page closed or reloaded");
    persist();
  });
}
