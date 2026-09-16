import { data } from "react-router";

import { LINK_LIFETIMES } from "../src/registrations.ts";
import { UserInputError } from "../src/users.ts";
import { assertSameOrigin } from "./auth.server.ts";

/**
 * Result shape every form action returns, so the client can show one
 * consistent confirmation or error.
 */
export type ActionResult<Extra extends object = object> =
  | ({ ok: true; message: string } & Extra)
  | { ok: false; error: string };

/**
 * Run a form action: check the origin, read the form, dispatch on `intent`.
 * A UserInputError becomes a 400 carrying its message; anything else is a
 * real failure and propagates.
 */
export async function handleForm<Extra extends object>(
  request: Request,
  handlers: Record<string, (form: FormData) => ActionResult<Extra> | Promise<ActionResult<Extra>>>,
) {
  assertSameOrigin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const handler = handlers[intent];
  if (!handler) {
    return data<ActionResult<Extra>>({ ok: false, error: "Unknown action." }, { status: 400 });
  }
  try {
    return data<ActionResult<Extra>>(await handler(form));
  } catch (err) {
    if (err instanceof UserInputError) {
      return data<ActionResult<Extra>>({ ok: false, error: err.message }, { status: 400 });
    }
    throw err;
  }
}

/** A positive integer form field, or a UserInputError. */
export function intField(form: FormData, name: string): number {
  const value = Number(form.get(name));
  if (!Number.isInteger(value) || value <= 0) throw new UserInputError("That request was incomplete.");
  return value;
}

export function stringField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * A link lifetime chosen from the fixed menu (the `ttl` field). The value must
 * match one of LINK_LIFETIMES exactly — an arbitrary number is refused.
 */
export function lifetimeFrom(form: FormData, fallbackMs: number): number {
  const raw = stringField(form, "ttl");
  if (!raw) return fallbackMs;
  const match = LINK_LIFETIMES.find((l) => String(l.ms) === raw);
  if (!match) throw new UserInputError("Pick a link lifetime.");
  return match.ms;
}
