import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import type { Op, OpPayload, OpResult, OpType } from "../../src/ops-schema.ts";
import { addCrumb } from "../bugs/breadcrumbs.ts";
import { useBugContext } from "../bugs/context.ts";
import { getEngine, useQueuedOps } from "../offline/client.ts";
import { applyPending } from "../offline/reducer.ts";
import { describe as describeOp } from "../offline/SyncStatusBadge.tsx";
import { SignedOutError } from "../offline/sync.ts";
import { dayHref } from "./day-href.ts";
import { type Fix, recentFix, refreshLocation } from "./location.ts";
import type { DayModel } from "./model.ts";
import { makeOp, sendOps } from "./ops-client.ts";
import { useDayRollover } from "./rollover.ts";
import { type Undoable, inverseOfAll } from "./undo.ts";

/**
 * The tracking screen's data and its one way of changing it.
 *
 * `model` is the server's copy of the day with every not-yet-reflected change
 * applied on top, so a change shows the instant it's made — online or not.
 * `dispatch` puts the change in the outbox and, if the server answers
 * promptly, returns its answer; otherwise the change is simply queued.
 *
 * An admin working on someone else's day uses the same screen "acting for"
 * them: changes go straight to the server (the outbox belongs to whoever is
 * signed in), nothing is kept on the device, and no location is attached.
 */

export interface ActingFor {
  userId: number;
  name: string;
  /** Their day pages live under this path: `${basePath}` is today, `${basePath}/${date}` any other day. */
  basePath: string;
}

export type DispatchResult = OpResult | { opId: string; ok: true; queued: true };

export interface Tracker {
  model: DayModel;
  /**
   * Make a change. Errors are shown to the person, except `note_required`,
   * which the caller handles. `quiet` suppresses the error message (the caller
   * shows it inline). `background` doesn't wait for the server and doesn't
   * mark the screen busy — for saves that happen as a side effect, like a note
   * saved when its field loses focus.
   */
  dispatch<T extends OpType>(
    type: T,
    payload: OpPayload<T>,
    opts?: { quiet?: boolean; background?: boolean },
  ): Promise<DispatchResult>;
  /** Make several changes, in order; resolves with each one's result. */
  dispatchAll(ops: { type: OpType; payload: unknown }[]): Promise<DispatchResult[]>;
  /** A foreground change is waiting for the server's answer. */
  pending: boolean;
  /** Set when an admin is working on someone else's day. */
  actingFor: ActingFor | null;
  /** Link to another day of the same person. */
  hrefFor(date: string): string;
  /** A recent location fix to attach to a change, if the person allows it. */
  location(): Fix | null;
  /**
   * The last change that can be put back, or null. Every change made through
   * `dispatch` that has an inverse (undo.ts) goes on a stack; `undo` dispatches
   * the inverse of the latest, or of the one given — a toast's Undo button
   * puts back the delete it announced, whatever has happened since.
   */
  undoable: Undoable | null;
  undo(which?: Undoable): Promise<void>;
  /** The top of the stack as it is this instant, for a toast shown right after a dispatch resolves. */
  latestUndoable(): Undoable | null;
}

/** How long a change waits for the server before being treated as queued. */
const ANSWER_WAIT_MS = 8_000;

/** How far back undo reaches. Enough for a wrong turn, not a day's history. */
const UNDO_DEPTH = 20;

const TrackerContext = createContext<Tracker | null>(null);

export function useTracker(): Tracker {
  const tracker = useContext(TrackerContext);
  if (!tracker) throw new Error("useTracker outside TrackerProvider");
  return tracker;
}

function reportFailure(result: DispatchResult): void {
  if (result.ok || result.code === "note_required") return;
  notifications.show({ color: "red", message: result.error, autoClose: 8000 });
}

export function TrackerProvider({
  model: base,
  actingFor = null,
  children,
}: {
  model: DayModel;
  actingFor?: ActingFor | null;
  children: React.ReactNode;
}) {
  const queued = useQueuedOps();
  const direct = useDirectOps(base, actingFor);
  const ops = actingFor ? direct.ops : queued;
  const [inFlight, setInFlight] = useState(0);
  // The stack lives in a ref — pushed to before a dispatch resolves, so a
  // toast shown right after can name the change — with a state copy of the
  // top for rendering.
  const undoStack = useRef<Undoable[]>([]);
  const [undoable, setUndoable] = useState<Undoable | null>(null);

  useEffect(() => {
    if (!actingFor) refreshLocation();
  }, [actingFor]);

  // A fresh server copy includes changes confirmed before it was requested.
  useEffect(() => {
    if (!actingFor) getEngine()?.reflect(base.fetchedAt);
  }, [base, actingFor]);

  // Showing the device's copy: keep trying the server until it answers.
  const revalidator = useRevalidator();
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  useEffect(() => {
    if (!base.offline) return;
    const retry = () => void revalidate.current();
    window.addEventListener("online", retry);
    const id = window.setInterval(retry, 20_000);
    return () => {
      window.removeEventListener("online", retry);
      window.clearInterval(id);
    };
  }, [base.offline]);

  // Midnight, reaching a page that was already open — see rollover.ts.
  const askAgain = useCallback(() => void revalidate.current(), []);
  useDayRollover(base.today, base.timezone, askAgain);

  const model = useMemo(() => (ops.length ? applyPending(base, ops) : base), [base, ops]);
  // A bug report carries the day as shown — the server's copy with the
  // device's changes on top — and the server's copy on its own.
  useBugContext("day", () => ({ shown: model, fromServer: base, pendingOps: ops, actingFor }));
  useBugContext("undo", () => undoStack.current.map((u) => u.label));
  // The day as it is right now, for working out what a change undoes —
  // read at dispatch time rather than captured, so `dispatch` stays stable.
  const current = useRef(model);
  current.current = model;

  const sendDirect = direct.send;
  const submit = useCallback(
    async (list: Op[], wait: boolean, opts: { undoable?: boolean } = {}): Promise<DispatchResult[]> => {
      // Worked out before the change, against the day it changes.
      const inverse = opts.undoable === false ? null : inverseOfAll(current.current, list, Date.now());
      if (wait) setInFlight((n) => n + 1);
      try {
        let results: DispatchResult[];
        if (actingFor) results = await sendDirect(list);
        else {
          const engine = getEngine();
          if (!engine) throw new Error("Changes can only be made in the browser");
          const answers = await Promise.all(list.map((op) => engine.enqueue(op, wait ? ANSWER_WAIT_MS : 0)));
          results = answers.map((a, i): DispatchResult => a ?? { opId: list[i]!.opId, ok: true, queued: true });
        }
        // Every change, and what came of it, for bug reports' breadcrumbs.
        list.forEach((op, i) => {
          const r = results[i];
          const outcome = !r ? "no answer" : !r.ok ? `refused: ${r.error}` : "queued" in r ? "queued" : "done";
          addCrumb("op", `${describeOp(op)} — ${outcome}`, { type: op.type, opId: op.opId, payload: op.payload, actingFor: actingFor?.userId ?? null });
        });
        // A refused change did nothing, so there is nothing to put back.
        if (inverse && results.every((r) => r.ok)) {
          undoStack.current = [...undoStack.current.slice(-(UNDO_DEPTH - 1)), inverse];
          setUndoable(inverse);
        }
        return results;
      } finally {
        if (wait) setInFlight((n) => n - 1);
      }
    },
    [actingFor, sendDirect],
  );

  const dispatch = useCallback<Tracker["dispatch"]>(
    async (type, payload, opts) => {
      const [result] = await submit([makeOp(type, payload)], !opts?.background);
      if (!opts?.quiet) reportFailure(result!);
      return result!;
    },
    [submit],
  );

  const dispatchAll = useCallback<Tracker["dispatchAll"]>(
    async (list) => {
      const results = await submit(
        list.map((o) => makeOp(o.type, o.payload as never)),
        true,
      );
      const firstFailure = results.find((r) => !r.ok);
      if (firstFailure) reportFailure(firstFailure);
      return results;
    },
    [submit],
  );

  const undo = useCallback(
    async (which?: Undoable) => {
      const entry = which ?? undoStack.current.at(-1);
      if (!entry) return;
      // Off the stack first: whatever the server says, this one has been
      // tried, and a refusal is reported like any other.
      undoStack.current = undoStack.current.filter((u) => u !== entry);
      setUndoable(undoStack.current.at(-1) ?? null);
      const results = await submit(
        entry.ops.map((o) => makeOp(o.type, o.payload as never)),
        true,
        { undoable: false },
      );
      const firstFailure = results.find((r) => !r.ok);
      if (firstFailure) reportFailure(firstFailure);
    },
    [submit],
  );
  const latestUndoable = useCallback(() => undoStack.current.at(-1) ?? null, []);

  // Ctrl/Cmd+Z anywhere on the screen that isn't a field with its own undo.
  const undoRef = useRef(undo);
  undoRef.current = undo;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "z" || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      void undoRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo<Tracker>(
    () => ({
      model,
      dispatch,
      dispatchAll,
      pending: inFlight > 0,
      actingFor,
      hrefFor: (date) =>
        actingFor
          ? date === model.today
            ? actingFor.basePath
            : `${actingFor.basePath}/${date}`
          : dayHref(date, model.today),
      location: () => (actingFor ? null : recentFix()),
      undoable,
      undo,
      latestUndoable,
    }),
    [model, dispatch, dispatchAll, inFlight, actingFor, undoable, undo, latestUndoable],
  );
  return <TrackerContext.Provider value={value}>{children}</TrackerContext.Provider>;
}

/**
 * Changes made while acting for someone: sent straight to the server, and
 * shown on screen until a copy fetched after the server confirmed them
 * arrives (the same rule the outbox follows).
 */
function useDirectOps(base: DayModel, actingFor: ActingFor | null) {
  const [items, setItems] = useState<{ op: Op; confirmedAt?: number }[]>([]);
  const revalidator = useRevalidator();
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  const endpoint = actingFor ? `/api/admin/people/${actingFor.userId}/ops` : null;

  useEffect(() => {
    const fetchedAt = base.fetchedAt;
    if (fetchedAt == null) return;
    setItems((list) => {
      const kept = list.filter((i) => i.confirmedAt == null || i.confirmedAt > fetchedAt);
      return kept.length === list.length ? list : kept;
    });
  }, [base]);

  const send = useCallback(
    async (ops: Op[]): Promise<DispatchResult[]> => {
      if (!endpoint) throw new Error("Not acting for anyone");
      const ids = new Set(ops.map((o) => o.opId));
      setItems((list) => [...list, ...ops.map((op) => ({ op }))]);
      let results: OpResult[];
      try {
        results = await sendOps(ops, endpoint);
      } catch (err) {
        setItems((list) => list.filter((i) => !ids.has(i.op.opId)));
        const error =
          err instanceof SignedOutError
            ? "You've been signed out, so that change wasn't saved. Sign in and try again."
            : "Couldn't reach the server, so that change wasn't saved. Try again once you're connected.";
        return ops.map((op) => ({ opId: op.opId, ok: false as const, error }));
      }
      const confirmedAt = Date.now();
      const accepted = new Set(results.filter((r) => r.ok).map((r) => r.opId));
      setItems((list) =>
        list
          .filter((i) => !ids.has(i.op.opId) || accepted.has(i.op.opId))
          .map((i) => (accepted.has(i.op.opId) ? { ...i, confirmedAt } : i)),
      );
      void revalidate.current();
      return results;
    },
    [endpoint],
  );

  const ops = useMemo(() => items.map((i) => i.op), [items]);
  return { ops, send };
}

/** A clock that re-renders its user every `intervalMs`. Undefined until mounted (SSR-safe). */
export function useNow(intervalMs = 1000): number | undefined {
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * A confirmation with an Undo button. Deleting never asks "are you sure?";
 * this is the safety net instead. The button puts back the change that was
 * just made — the one on top of the undo stack when the toast is shown —
 * and that one in particular, whatever has happened since.
 */
export function useUndoToast() {
  const { undo, latestUndoable } = useTracker();
  const busy = useRef(false);
  return useCallback(
    (message: string) => {
      // The stack is pushed to before the dispatch resolves, and the toast is
      // shown right after, so the top is the change being announced.
      const which = latestUndoable();
      const id = notifications.show({
        autoClose: 10_000,
        withCloseButton: true,
        message: (
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm">{message}</Text>
            {which && (
              <Button
                size="compact-sm"
                variant="light"
                onClick={async () => {
                  if (busy.current) return;
                  busy.current = true;
                  notifications.hide(id);
                  try {
                    await undo(which);
                  } finally {
                    busy.current = false;
                  }
                }}
              >
                Undo
              </Button>
            )}
          </Group>
        ),
      });
    },
    [undo, latestUndoable],
  );
}
