import {
  type MiddlewareFunction,
  type RouterContextProvider,
  createContext,
  createCookie,
  data,
  redirect,
} from "react-router";

import { config } from "../src/config.server.ts";
import { SESSION_TTL_MS, type Session, resolveSession } from "../src/sessions.ts";
import { UserInputError, type User } from "../src/users.ts";
import { CEREMONY_TTL_MS } from "../src/webauthn.ts";

/**
 * HTTP-side auth: cookies, the middleware that resolves the current person,
 * and the guards loaders and actions call.
 */

// `Secure` cookies over plain http only work on localhost in some browsers,
// so follow the scheme the app is actually served on.
const secure = new URL(config.publicBaseUrl).protocol === "https:";

const base = {
  httpOnly: true,
  secure,
  sameSite: "lax" as const,
  path: "/",
  secrets: [config.sessionSecret],
};

export const sessionCookie = createCookie("tt_session", {
  ...base,
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
});

/** Names the in-flight WebAuthn ceremony between its options and verify calls. */
export const ceremonyCookie = createCookie("tt_ceremony", {
  ...base,
  maxAge: Math.floor(CEREMONY_TTL_MS / 1000),
});

/**
 * Holds a one-time link's token after /join/:token is opened, so the token
 * leaves the address bar and history. Long enough to read the page and find
 * the phone's passkey prompt; the link itself enforces the real expiry.
 */
export const joinCookie = createCookie("tt_join", { ...base, maxAge: 30 * 60 });

export async function readCookie(
  cookie: typeof sessionCookie,
  request: Request,
): Promise<string | null> {
  const value: unknown = await cookie.parse(request.headers.get("Cookie"));
  return typeof value === "string" && value ? value : null;
}

export function clearCookie(cookie: typeof sessionCookie): Promise<string> {
  return cookie.serialize("", { maxAge: 0 });
}

// ---- current person ---------------------------------------------------------

export interface Auth {
  user: User;
  session: Session;
}

export const authContext = createContext<Auth | null>(null);

/**
 * Root middleware: resolve the session cookie once per request and publish
 * the result on the router context. When the session's expiry has just slid
 * forward, re-send the cookie so the browser's copy slides too — unless the
 * route already set or cleared it (sign-in, sign-out).
 */
export const authMiddleware: MiddlewareFunction<Response> = async ({ request, context }, next) => {
  const token = await readCookie(sessionCookie, request);
  const resolved = resolveSession(token);
  context.set(authContext, resolved ? { user: resolved.user, session: resolved.session } : null);

  const response = await next();
  if (!resolved?.refreshed || !token) return response;

  const alreadySet = response.headers
    .getSetCookie()
    .some((c) => c.startsWith("tt_session="));
  if (alreadySet) return response;

  const header = await sessionCookie.serialize(token);
  try {
    response.headers.append("Set-Cookie", header);
    return response;
  } catch {
    // Some responses have immutable headers; re-wrap rather than drop the refresh.
    const copy = new Response(response.body, response);
    copy.headers.append("Set-Cookie", header);
    return copy;
  }
};

type Ctx = Readonly<RouterContextProvider>;

export function getAuth(context: Ctx): Auth | null {
  return context.get(authContext);
}

/** The signed-in person, or a redirect to sign-in that returns here afterwards. */
export function requireUser(context: Ctx, request: Request): Auth {
  const auth = getAuth(context);
  if (auth) return auth;
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  throw redirect(next === "/" ? "/signin" : `/signin?next=${encodeURIComponent(next)}`);
}

export function requireAdmin(context: Ctx, request: Request): Auth {
  const auth = requireUser(context, request);
  if (auth.user.role !== "admin") {
    throw data("This page is for admins.", { status: 403 });
  }
  return auth;
}

// ---- request hygiene -----------------------------------------------------------

/**
 * Refuse state-changing requests that didn't come from our own pages.
 * SameSite=Lax already withholds cookies from cross-site POSTs; this is the
 * belt to that pair of braces, and it covers the JSON API as well as forms.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin !== new URL(config.publicBaseUrl).origin) {
    throw Response.json({ error: "Cross-origin request refused." }, { status: 403 });
  }
}

/** Parse a JSON body, answering 400 instead of throwing a 500 on garbage. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw Response.json({ error: "Malformed request." }, { status: 400 });
}

/**
 * Turn a UserInputError into a 400 with its message; let anything else
 * propagate as a real error (logged, generic message to the user).
 */
export function userErrorResponse(err: unknown): Response {
  if (err instanceof UserInputError) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  throw err;
}

export function isPost(request: Request): void {
  if (request.method !== "POST") {
    throw Response.json({ error: "Method not allowed." }, { status: 405, headers: { Allow: "POST" } });
  }
}
