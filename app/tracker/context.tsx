import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import type { OpPayload, OpResult, OpType } from "../../src/ops-schema.ts";
import { refreshLocation } from "./location.ts";
import type { DayModel } from "./model.ts";
import { SignedOutError, makeOp, sendOps } from "./ops-client.ts";

/**
 * The tracking screen's data and its one way of changing it.
 *
 * Components get `model` to render and `dispatch` to change things; nothing
 * else talks to the server. Phase 3 swaps the implementation of both (local
 * store + outbox) behind this same interface.
 */

export type DispatchResult = OpResult | { opId: string; ok: false; code: "offline" | "signed_out"; error: string };

export interface Tracker {
  model: DayModel;
  /**
   * Send one op. Errors are shown to the person, except `note_required`, which
   * the caller handles. `quiet` suppresses the error toast (the caller shows it
   * inline); `background` keeps the op from marking the screen busy — use it
   * for saves that happen as a side effect, like a note saved when its field
   * loses focus, so they never disable the button that was just tapped.
   */
  dispatch<T extends OpType>(
    type: T,
    payload: OpPayload<T>,
    opts?: { quiet?: boolean; background?: boolean },
  ): Promise<DispatchResult>;
  /** Send several ops in order, as one request. */
  dispatchAll(ops: { type: OpType; payload: unknown }[]): Promise<DispatchResult[]>;
  pending: boolean;
}

const TrackerContext = createContext<Tracker | null>(null);

export function useTracker(): Tracker {
  const tracker = useContext(TrackerContext);
  if (!tracker) throw new Error("useTracker outside TrackerProvider");
  return tracker;
}

function reportFailure(result: DispatchResult): void {
  if (result.ok || result.code === "note_required") return;
  notifications.show({
    color: "red",
    title: result.code === "offline" ? "Not saved" : undefined,
    message: result.error,
    autoClose: result.code === "offline" ? false : 8000,
  });
}

export function TrackerProvider({ model, children }: { model: DayModel; children: React.ReactNode }) {
  const revalidator = useRevalidator();
  const [inFlight, setInFlight] = useState(0);

  useEffect(() => {
    refreshLocation();
  }, []);

  const send = useCallback(
    async (ops: ReturnType<typeof makeOp>[], background = false): Promise<DispatchResult[]> => {
      if (!background) setInFlight((n) => n + 1);
      try {
        const results = await sendOps(ops);
        await revalidator.revalidate();
        return results;
      } catch (err) {
        const code = err instanceof SignedOutError ? ("signed_out" as const) : ("offline" as const);
        const error =
          code === "offline"
            ? "Couldn't reach the server, so that change wasn't saved. Try again when you're back online."
            : (err as Error).message;
        return ops.map((op) => ({ opId: op.opId, ok: false as const, code, error }));
      } finally {
        if (!background) setInFlight((n) => n - 1);
      }
    },
    [revalidator],
  );

  const dispatch = useCallback<Tracker["dispatch"]>(
    async (type, payload, opts) => {
      const [result] = await send([makeOp(type, payload)], opts?.background);
      if (!opts?.quiet) reportFailure(result!);
      return result!;
    },
    [send],
  );

  const dispatchAll = useCallback<Tracker["dispatchAll"]>(
    async (list) => {
      const results = await send(list.map((o) => makeOp(o.type, o.payload as never)));
      const firstFailure = results.find((r) => !r.ok);
      if (firstFailure) reportFailure(firstFailure);
      return results;
    },
    [send],
  );

  const value = useMemo<Tracker>(
    () => ({ model, dispatch, dispatchAll, pending: inFlight > 0 }),
    [model, dispatch, dispatchAll, inFlight],
  );
  return <TrackerContext.Provider value={value}>{children}</TrackerContext.Provider>;
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
