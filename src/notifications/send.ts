import webpush from "web-push";

import { config } from "../config.server.ts";

/**
 * Sending one message to one browser. Behind an interface so the tests (and
 * the e2e server) use a fake that records instead of calling a push service.
 */

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  /** Seconds the push service may hold it for a device that's offline. */
  ttl: number;
  /** A newer message with the same topic replaces an undelivered older one. */
  topic: string;
  urgency: "low" | "normal" | "high";
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

export interface PushSender {
  send(target: PushTarget, payload: string, options: PushOptions): Promise<PushResult>;
}

/** Whether this server can send at all: both VAPID keys and a subject. */
export function pushConfigured(): boolean {
  const p = config.push;
  return Boolean(p.vapidPublicKey && p.vapidPrivateKey && p.vapidSubject);
}

export function webPushSender(): PushSender {
  const { vapidPublicKey, vapidPrivateKey, vapidSubject } = config.push;
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) throw new Error("Web Push isn't configured.");
  const vapidDetails = { subject: vapidSubject, publicKey: vapidPublicKey, privateKey: vapidPrivateKey };
  return {
    async send(target, payload, options) {
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          payload,
          { vapidDetails, TTL: options.ttl, topic: options.topic, urgency: options.urgency, timeout: 15_000 },
        );
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410: the browser unsubscribed, or the subscription expired. It
        // will never work again; forget it.
        const gone = status === 404 || status === 410;
        const body = (err as { body?: string }).body;
        const error = `${status ? `${status} ` : ""}${body || (err instanceof Error ? err.message : String(err))}`.trim();
        return { ok: false, gone, error };
      }
    },
  };
}

/** For tests: remembers everything, answers per endpoint. */
export function fakeSender(answer: (target: PushTarget) => PushResult = () => ({ ok: true })) {
  const sent: { target: PushTarget; payload: Record<string, unknown>; options: PushOptions }[] = [];
  const sender: PushSender = {
    async send(target, payload, options) {
      sent.push({ target, payload: JSON.parse(payload), options });
      return answer(target);
    },
  };
  return { sender, sent };
}
