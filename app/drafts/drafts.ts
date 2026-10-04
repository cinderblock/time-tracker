import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Text being typed, kept on the device until it's saved.
 *
 * A reload — the app updating itself, a crash, a phone that closed the app in
 * the background — used to take whatever was half-typed with it. Fields that
 * use `useDraft` write what's in them to localStorage as it changes and put it
 * back after any reload, so the person carries on where they were. Saving or
 * cancelling clears the draft.
 *
 * Keys are per person and per field (`tt-draft:<scope>:<field>`), so one
 * device shared by two people, or an admin working on someone's day, never
 * mixes them up. Drafts older than a week are dropped: by then the text has
 * either been saved another way or isn't wanted.
 */

const PREFIX = "tt-draft:";
export const DRAFT_MAX_AGE_MS = 7 * 24 * 3600_000;

interface Stored<T> {
  value: T;
  at: number;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Some privacy modes throw on access: no drafts, as before.
    return null;
  }
}

export function draftKey(scope: string, field: string): string {
  return `${PREFIX}${scope}:${field}`;
}

export function readDraft<T>(key: string, now: number = Date.now()): T | undefined {
  const s = storage();
  const raw = s?.getItem(key);
  if (!raw) return undefined;
  try {
    const stored = JSON.parse(raw) as Stored<T>;
    if (now - stored.at > DRAFT_MAX_AGE_MS) {
      s!.removeItem(key);
      return undefined;
    }
    return stored.value;
  } catch {
    s!.removeItem(key);
    return undefined;
  }
}

export function writeDraft<T>(key: string, value: T, now: number = Date.now()): void {
  try {
    storage()?.setItem(key, JSON.stringify({ value, at: now } satisfies Stored<T>));
  } catch {
    // Full or unavailable: the field still works, it just isn't kept.
  }
}

export function removeDraft(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

/**
 * Every draft under a scope, or every draft on the device — what signing out
 * does: half-typed notes are the person's, and the next person to sign in
 * here shouldn't find them.
 */
export function clearDrafts(scope?: string): void {
  const s = storage();
  if (!s) return;
  const start = scope == null ? PREFIX : `${PREFIX}${scope}:`;
  const doomed: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (key?.startsWith(start)) doomed.push(key);
  }
  for (const key of doomed) s.removeItem(key);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `useState` that survives a reload. `key` null means "don't keep this one"
 * (no person known yet, say). The value is kept only while it differs from
 * `initial`; back at `initial` — or `discard()`ed — there is no draft.
 *
 * Read after mount, not during render: the server renders `initial`, and the
 * first render in the browser has to match it.
 */
export function useDraft<T>(
  key: string | null,
  initial: T,
): [value: T, set: (next: T | ((prev: T) => T)) => void, discard: () => void, restored: boolean] {
  const [value, setValue] = useState<T>(initial);
  const [restored, setRestored] = useState(false);
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!key) return;
    const stored = readDraft<T>(key);
    if (stored !== undefined && !same(stored, initialRef.current)) {
      setValue(stored);
      setRestored(true);
    } else {
      setRestored(false);
    }
  }, [key]);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      const k = keyRef.current;
      if (k) {
        if (same(v, initialRef.current)) removeDraft(k);
        else writeDraft(k, v);
      }
      return v;
    });
  }, []);

  const discard = useCallback(() => {
    if (keyRef.current) removeDraft(keyRef.current);
    setRestored(false);
    setValue(initialRef.current);
  }, []);

  return [value, set, discard, restored];
}
