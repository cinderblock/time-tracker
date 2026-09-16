import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import type { Op, OpPayload, OpResult, OpType } from "../../src/ops-schema.ts";
import { getEngine, useQueuedOps } from "../offline/client.ts";
import { applyPending } from "../offline/reducer.ts";
import { SignedOutError } from "../offline/sync.ts";
import { dayHref } from "./day-href.ts";
import { type Fix, recentFix, refreshLocation } from "./location.ts";
import type { DayModel } from "./model.ts";
import { makeOp, sendOps } from "./ops-client.ts";

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
}

/** How long a change waits for the server before being treated as queued. */
const ANSWER_WAIT_MS = 8_000;

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

  const model = useMemo(() => (ops.length ? applyPending(base, ops) : base), [base, ops]);

  const sendDirect = direct.send;
  const submit = useCallback(
    async (list: Op[], wait: boolean): Promise<DispatchResult[]> => {
      if (wait) setInFlight((n) => n + 1);
      try {
        if (actingFor) return await sendDirect(list);
        const engine = getEngine();
        if (!engine) throw new Error("Changes can only be made in the browser");
        const answers = await Promise.all(list.map((op) => engine.enqueue(op, wait ? ANSWER_WAIT_MS : 0)));
        return answers.map((a, i): DispatchResult => a ?? { opId: list[i]!.opId, ok: true, queued: true });
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
    }),
    [model, dispatch, dispatchAll, inFlight, actingFor],
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
 * this is the safety net instead.
 */
export function useUndoToast() {
  const busy = useRef(false);
  return useCallback((message: string, undo: () => Promise<unknown>) => {
    const id = notifications.show({
      autoClose: 10_000,
      withCloseButton: true,
      message: (
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Text size="sm">{message}</Text>
          <Button
            size="compact-sm"
            variant="light"
            onClick={async () => {
              if (busy.current) return;
              busy.current = true;
              notifications.hide(id);
              try {
                await undo();
              } finally {
                busy.current = false;
              }
            }}
          >
            Undo
          </Button>
        </Group>
      ),
    });
  }, []);
}
