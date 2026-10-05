import { CODE_BUILD } from "../../src/build-info.ts";
import { recentCrumbs } from "./breadcrumbs.ts";
import { recentErrors } from "./errors.ts";

/**
 * This app's other open tabs, for a bug report: a page can't see anything
 * else the browser has open, but every tab of this app answers a roll call
 * on a BroadcastChannel — where it is, which build it runs, what it did
 * lately. Two tabs on different builds, or one left on a stale day, is often
 * the whole story.
 */

const CHANNEL = "tt-tabs";
const tabId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());
const openedAt = Date.now();
let lastActive = Date.now();

export interface TabInfo {
  tabId: string;
  url: string;
  title: string;
  visibility: DocumentVisibilityState;
  focused: boolean;
  revision: string;
  openedAt: number;
  lastActive: number;
  breadcrumbs: ReturnType<typeof recentCrumbs>;
  errors: ReturnType<typeof recentErrors>;
}

function describeThisTab(): TabInfo {
  return {
    tabId,
    url: location.href,
    title: document.title,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    revision: CODE_BUILD.revision,
    openedAt,
    lastActive,
    breadcrumbs: recentCrumbs(20),
    errors: recentErrors().slice(-5),
  };
}

let channel: BroadcastChannel | null = null;

/** Answer other tabs' roll calls. Once per page. */
export function installTabRollCall(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<{ type: string; askId?: string }>) => {
    if (event.data?.type === "who" && event.data.askId) {
      channel?.postMessage({ type: "here", askId: event.data.askId, tab: describeThisTab() });
    }
  };
  for (const e of ["pointerdown", "keydown", "focus"]) {
    window.addEventListener(e, () => (lastActive = Date.now()), { passive: true, capture: true });
  }
}

/** This tab, and every other open tab of the app that answers within `waitMs`. */
export async function rollCall(waitMs = 400): Promise<{ thisTab: TabInfo; otherTabs: TabInfo[] }> {
  const thisTab = describeThisTab();
  if (typeof BroadcastChannel === "undefined") return { thisTab, otherTabs: [] };
  const askId = `${tabId}:${Date.now()}`;
  const listener = new BroadcastChannel(CHANNEL);
  const otherTabs: TabInfo[] = [];
  listener.onmessage = (event: MessageEvent<{ type: string; askId?: string; tab?: TabInfo }>) => {
    // This page's own roll-call channel answers too (it's a different channel object): not another tab.
    if (event.data?.type === "here" && event.data.askId === askId && event.data.tab && event.data.tab.tabId !== tabId) {
      otherTabs.push(event.data.tab);
    }
  };
  listener.postMessage({ type: "who", askId });
  await new Promise((r) => setTimeout(r, waitMs));
  listener.close();
  return { thisTab, otherTabs };
}
