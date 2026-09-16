import { listCredentials } from "../src/credentials.ts";
import { formatDate, formatRelative } from "../src/format.ts";
import { listSessions } from "../src/sessions.ts";
import { describeUserAgent } from "../src/user-agent.ts";
import type { PasskeyView, SessionView } from "./components/credential-lists.tsx";

/** A person's passkeys, shaped for display. */
export function passkeyViews(userId: number, now = Date.now()): PasskeyView[] {
  return listCredentials(userId).map((c) => ({
    id: c.id,
    nickname: c.nickname,
    created: formatDate(c.createdAt),
    lastUsed: c.lastUsedAt ? formatRelative(c.lastUsedAt, now) : "never",
    synced: c.backedUp,
  }));
}

/** A person's live sessions, shaped for display. */
export function sessionViews(userId: number, currentSessionId: string | null, now = Date.now()): SessionView[] {
  return listSessions(userId, now).map((s) => ({
    id: s.id,
    device: describeUserAgent(s.userAgent),
    passkey: s.credentialNickname,
    lastUsed: formatRelative(s.lastUsedAt, now),
    current: s.id === currentSessionId,
  }));
}
