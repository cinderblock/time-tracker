import type { ClientError } from "../../src/bug-schema.ts";
import { LIMITS } from "../../src/bug-schema.ts";
import { CODE_BUILD } from "../../src/build-info.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { addCrumb, recentCrumbs } from "./breadcrumbs.ts";
import { problemQueue } from "./queue.ts";

/**
 * Every error in the page reaches the server on its own: uncaught errors,
 * rejected promises nobody handled, `console.error`, a failed script or
 * stylesheet load, and what the root error boundary catches.
 *
 * Repeats on one page are counted rather than sent again, a few seconds'
 * worth go as one batch, and the batch goes through the problem queue, so an
 * error that happens offline still arrives. Each carries the breadcrumbs that
 * led to it. Nothing here may itself throw into the page.
 */

const BATCH_DELAY_MS = 3000;
/** After this many in one page, stop sending: something is looping. */
const MAX_PER_PAGE = 300;
const CRUMBS_PER_ERROR = 30;

type Source = ClientError["source"];

interface Pending {
  error: ClientError;
}

const pending = new Map<string, Pending>();
const recent: ClientError[] = [];
let sentThisPage = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let reporting = false;

/** The latest errors on this page (for a bug report), oldest first. */
export function recentErrors(): ClientError[] {
  return [...recent];
}

function describe(value: unknown): { message: string; name?: string; stack?: string } {
  if (value instanceof Error) {
    return { message: value.message || String(value), name: value.name, stack: value.stack };
  }
  if (typeof value === "string") return { message: value };
  try {
    return { message: JSON.stringify(value) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}

/**
 * A console call's arguments as the line it prints: format directives in the
 * first string filled in (%s %d %i %f %o %O), styling (%c) dropped along with
 * its CSS, then the rest.
 */
export function consoleText(args: readonly unknown[]): string {
  const text = (a: unknown) => (a instanceof Error ? a.message : typeof a === "string" ? a : describe(a).message);
  if (typeof args[0] !== "string") return args.map(text).join(" ");
  let next = 1;
  const first = args[0].replace(/%([csdifoO%])/g, (whole, d: string) => {
    if (d === "%") return "%";
    if (next >= args.length) return whole;
    const value = args[next++];
    return d === "c" ? "" : text(value);
  });
  return [first, ...args.slice(next).map(text)].join(" ").replace(/\s+/g, " ").trim();
}

/** Report an error. Safe to call from anywhere in the browser; never throws. */
export function reportError(value: unknown, source: Source, extra?: string): void {
  if (typeof window === "undefined" || reporting) return;
  reporting = true;
  try {
    const d = describe(value);
    const message = (extra ? `${extra}: ${d.message}` : d.message).slice(0, LIMITS.messageLength);
    addCrumb("error", message, { source });
    const key = `${d.name ?? ""}|${message}|${(d.stack ?? "").split("\n").slice(0, 3).join("|")}`;
    const already = pending.get(key);
    if (already) {
      already.error.repeats++;
      return;
    }
    if (sentThisPage >= MAX_PER_PAGE) return;
    sentThisPage++;
    const error: ClientError = {
      message,
      name: d.name,
      stack: d.stack?.slice(0, LIMITS.stackLength),
      source,
      at: Date.now(),
      repeats: 1,
      url: location.href,
      revision: CODE_BUILD.revision,
      breadcrumbs: recentCrumbs(CRUMBS_PER_ERROR),
    };
    pending.set(key, { error });
    recent.push(error);
    if (recent.length > 20) recent.shift();
    timer ??= setTimeout(flushErrors, BATCH_DELAY_MS);
  } catch {
    // reporting must never be what breaks the page
  } finally {
    reporting = false;
  }
}

/** Send what's collected now (also on leaving the page). */
export function flushErrors(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (pending.size === 0) return;
  const errors = [...pending.values()].map((p) => p.error);
  pending.clear();
  for (let i = 0; i < errors.length; i += LIMITS.errorsPerBatch) {
    void problemQueue()
      .add({ key: `errors:${uuidv7()}`, kind: "errors", userId: null, body: { errors: errors.slice(i, i + LIMITS.errorsPerBatch) } })
      .catch(() => undefined);
  }
}

let installed = false;

/** Start listening. Once per page, as early as possible. */
export function installErrorCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener(
    "error",
    (event: Event) => {
      if (event instanceof ErrorEvent) {
        reportError(event.error ?? event.message, "error");
        return;
      }
      // A script, stylesheet or image that didn't load (captured, as these don't bubble).
      const el = event.target;
      if (el instanceof HTMLScriptElement || el instanceof HTMLLinkElement || el instanceof HTMLImageElement) {
        const what = el instanceof HTMLScriptElement ? "script" : el instanceof HTMLLinkElement ? "stylesheet" : "image";
        const url = el instanceof HTMLLinkElement ? el.href : el.src;
        reportError(`Failed to load ${what} ${url}`, "error");
      }
    },
    { capture: true },
  );
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason, "unhandledrejection", "Unhandled rejection"));

  // console.error is how libraries (React among them) say something went
  // wrong without throwing. Passed through untouched, and reported.
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    const err = args.find((a) => a instanceof Error);
    const text = consoleText(args);
    if (!err) {
      reportError(text, "console");
      return;
    }
    // The whole line as the message, the error's own name and stack.
    const combined = new Error(text);
    combined.name = err.name;
    combined.stack = err.stack;
    reportError(combined, "console");
  };
  const warn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    warn(...args);
    addCrumb("console", consoleText(args).slice(0, 500), { level: "warn" });
  };

  // Requests the app makes: the failures, and how long the API took.
  const fetchOriginal = window.fetch.bind(window);
  const watched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const started = performance.now();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const raw = input instanceof Request ? input.url : String(input);
    const url = raw.startsWith(location.origin) ? raw.slice(location.origin.length) : raw;
    const path = url.split("?")[0] ?? url;
    // The error and report requests themselves would only be noise.
    const quiet = path.startsWith("/api/client-errors") || path.startsWith("/api/bug-reports");
    try {
      const response = await fetchOriginal(input, init);
      if (!quiet && (!response.ok || path.startsWith("/api/") || method !== "GET")) {
        addCrumb("net", `${method} ${path} ${response.status}`, { ms: Math.round(performance.now() - started) });
      }
      return response;
    } catch (err) {
      if (!quiet) addCrumb("net", `${method} ${path} failed: ${describe(err).message}`, { ms: Math.round(performance.now() - started) });
      throw err;
    }
  };
  window.fetch = Object.assign(watched, { preconnect: window.fetch.preconnect }) as typeof fetch;

  window.addEventListener("pagehide", flushErrors);
}
