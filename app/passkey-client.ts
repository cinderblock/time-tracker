import {
  WebAuthnError,
  browserSupportsWebAuthn,
  sendSignal,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";

/**
 * Browser half of the passkey flows. Each function runs one full ceremony
 * against the API routes and resolves to where the app should go next, or
 * throws a PasskeyError whose message is fit to show the person.
 */

export class PasskeyError extends Error {
  /** True when the person dismissed the prompt — not worth an alarming message. */
  readonly cancelled: boolean;
  constructor(message: string, cancelled = false) {
    super(message);
    this.name = "PasskeyError";
    this.cancelled = cancelled;
  }
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new PasskeyError("Can't reach the server. Check your connection and try again.");
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof json.error === "string" ? json.error : "Something went wrong. Please try again.";
    const unknown = json.unknownCredential as { rpID: string; credentialID: string } | null | undefined;
    if (unknown) {
      // Ask the person's passkey manager to stop offering a passkey we no
      // longer recognise. Best effort: unsupported browsers just ignore it.
      await sendSignal({ signalName: "unknownCredential", ...unknown }).catch(() => {});
    }
    throw new PasskeyError(message);
  }
  return json;
}

/** Translate the browser's WebAuthn failures into something a person can act on. */
function explain(err: unknown, verb: "create" | "use"): never {
  if (err instanceof PasskeyError) throw err;
  const name = err instanceof WebAuthnError ? err.code : err instanceof Error ? err.name : "";
  const cause = err instanceof WebAuthnError && err.cause instanceof Error ? err.cause.name : name;
  if (cause === "NotAllowedError" || cause === "AbortError" || name === "ERROR_CEREMONY_ABORTED") {
    throw new PasskeyError(
      verb === "create" ? "Passkey setup was cancelled." : "Sign-in was cancelled.",
      true,
    );
  }
  if (name === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || cause === "InvalidStateError") {
    throw new PasskeyError("This device already has a passkey for this account.");
  }
  console.error(err);
  throw new PasskeyError(
    verb === "create"
      ? "This device couldn't create a passkey. Try a different browser or device."
      : "This device couldn't use a passkey. Try again, or use another device.",
  );
}

/** Register a passkey. `name` is required when a one-time link creates a new person. */
export async function registerPasskey(name?: string): Promise<string> {
  if (!passkeysSupported()) throw new PasskeyError("This browser doesn't support passkeys.");
  const { options } = await post("/api/passkey/register-options", { name });
  let response;
  try {
    response = await startRegistration({ optionsJSON: options as never });
  } catch (err) {
    explain(err, "create");
  }
  const result = await post("/api/passkey/register-verify", { response });
  return typeof result.redirectTo === "string" ? result.redirectTo : "/";
}

export async function signInWithPasskey(next: string | null): Promise<string> {
  if (!passkeysSupported()) throw new PasskeyError("This browser doesn't support passkeys.");
  const { options } = await post("/api/passkey/signin-options", {});
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options as never });
  } catch (err) {
    explain(err, "use");
  }
  const result = await post("/api/passkey/signin-verify", { response, next });
  return typeof result.redirectTo === "string" ? result.redirectTo : "/";
}
