/**
 * The browser's side of Web Push: can this browser receive notifications,
 * and turning it on or off. The server keeps which browsers belong to whom
 * (src/notifications/store.ts); this only talks to the browser.
 */

export type PushSupport =
  /** Ready: notifications can be turned on here. */
  | { kind: "ready" }
  /** An iPhone or iPad outside the home-screen app: Safari only allows it there. */
  | { kind: "ios-needs-install" }
  /** The browser has no Web Push at all. */
  | { kind: "unsupported" }
  /** The person (or a policy) blocked notifications for this site. */
  | { kind: "denied" }
  /** No service worker in this window (development, or it failed to register). */
  | { kind: "no-worker" };

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Whether this site may show notifications. The Permissions API first: it is
 * the live answer (headless Chromium, for one, leaves `Notification.permission`
 * at "denied" after a grant). Browsers without it for notifications fall back.
 */
export async function notificationPermission(): Promise<NotificationPermission> {
  try {
    const status = await navigator.permissions.query({ name: "notifications" });
    return status.state === "prompt" ? "default" : status.state;
  } catch {
    return Notification.permission;
  }
}

export async function pushSupport(): Promise<PushSupport> {
  if (typeof window === "undefined") return { kind: "unsupported" };
  const hasPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!hasPush) return isIos() && !isStandalone() ? { kind: "ios-needs-install" } : { kind: "unsupported" };
  if ((await notificationPermission()) === "denied") return { kind: "denied" };
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return { kind: "no-worker" };
  return { kind: "ready" };
}

/** This browser's current subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager?.getSubscription()) ?? null;
}

export class PushError extends Error {}

/**
 * Ask for permission and subscribe. Must run from a tap: browsers refuse a
 * permission prompt that isn't the direct result of one.
 */
export async function subscribe(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushError(
      permission === "denied"
        ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again."
        : "Notifications weren't allowed.",
    );
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw new PushError("The app's background helper isn't running here. Reload the page and try again.");
  const key = base64UrlToBytes(vapidPublicKey);
  const existing = await registration.pushManager.getSubscription();
  // A subscription made for a different server key can't be used; replace it.
  if (existing && !sameKey(existing.options.applicationServerKey, key)) await existing.unsubscribe();
  const subscription =
    (existing && sameKey(existing.options.applicationServerKey, key) ? existing : null) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  return subscription.toJSON();
}

/** Stop this browser receiving anything. Returns the endpoint it had, if any. */
export async function unsubscribe(): Promise<string | null> {
  const subscription = await currentSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}
