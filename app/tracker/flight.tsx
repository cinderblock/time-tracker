import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import classes from "./flight.module.css";

/**
 * Time seen moving from one column of the day to the other.
 *
 * Work becomes hours in two ways — a timer stops (or is switched away from),
 * and a job's notes are turned into time — and both end with the left column
 * losing something and the right column quietly holding it. `flyToEntry`
 * sends a pill carrying the duration from where the change was made to the
 * row it belongs to, and flashes the row as it lands, so the flow is
 * something you watch rather than something you work out. Nothing depends on
 * it finishing: the data is in place first, and a person who asked for no
 * motion just gets the flash.
 */

/** A point on the page, in document coordinates — scrolling doesn't move it. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Note where something is *now*, to fly from once the change has gone
 * through. Take this before making the change, not after: stopping a timer
 * unmounts the card it was on, and React empties the ref before the dispatch
 * resolves — by then there is nothing left to measure.
 */
export function whereItIs(el: HTMLElement | null): Point | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2 + window.scrollX, y: r.top + r.height / 2 + window.scrollY };
}

interface Flight {
  /**
   * Send `label` from `from` to the entry row `entryId`, then flash that row.
   * Call it once the change has succeeded, with the point `whereItIs` took
   * beforehand; without one, the row just flashes.
   */
  flyToEntry(entryId: string, label: string, from: Point | null): void;
  /** The entry row that has just landed, if any. */
  landed: string | null;
}

interface Pending {
  entryId: string;
  label: string;
  from: Point;
}

/** Outside a provider — or on the server — this is inert, not an error. */
const NO_FLIGHT: Flight = { flyToEntry: () => {}, landed: null };
const FlightContext = createContext<Flight>(NO_FLIGHT);

export function useFlight(): Flight {
  return useContext(FlightContext);
}

/** Mantine's modal fades over ~200ms; the flight waits so it isn't hidden. */
const MODAL_CLOSE_MS = 220;
const FLIGHT_MS = 620;
const FLASH_MS = 900;

export function FlightProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const clearFlash = useRef(0);

  const flash = useCallback((entryId: string) => {
    setLanded(entryId);
    window.clearTimeout(clearFlash.current);
    clearFlash.current = window.setTimeout(() => setLanded(null), FLASH_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(clearFlash.current), []);

  const flyToEntry = useCallback<Flight["flyToEntry"]>(
    (entryId, label, from) => {
      if (!from || noMotion()) {
        flash(entryId);
        return;
      }
      setPending({ entryId, label, from });
    },
    [flash],
  );

  // Stable: the flight's effect must not restart when the flash re-renders.
  const arrived = useCallback(
    (entryId: string) => {
      setPending(null);
      flash(entryId);
    },
    [flash],
  );

  const value = useMemo<Flight>(() => ({ flyToEntry, landed }), [flyToEntry, landed]);

  return (
    <FlightContext.Provider value={value}>
      {children}
      {pending && <Ghost key={pending.entryId} pending={pending} onArrived={arrived} />}
    </FlightContext.Provider>
  );
}

/** The class an entry row wears while it flashes, or nothing. */
export function landingClass(landed: string | null, entryId: string): string | undefined {
  return landed === entryId ? classes.landed : undefined;
}

/**
 * The pill in flight. On a phone the row it is flying to is usually below the
 * fold, so it brings that into view first and lets the scrolling finish
 * before measuring anything — including the source, which is held in
 * document coordinates precisely so that scroll can't strand it.
 */
function Ghost({ pending, onArrived }: { pending: Pending; onArrived: (entryId: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const flashTheRow = () => {
      if (!cancelled) onArrived(pending.entryId);
    };
    void (async () => {
      await delay(MODAL_CLOSE_MS);
      const row = await waitFor(() => document.querySelector<HTMLElement>(`[data-entry-id="${pending.entryId}"]`));
      const ghost = ref.current;
      if (cancelled || !row || !ghost) {
        flashTheRow();
        return;
      }
      const to = centre(await reveal(row));
      // Back to viewport coordinates, *after* any scrolling has settled — the
      // source may well have moved up the screen to make room for the row.
      const from = { x: pending.from.x - window.scrollX, y: pending.from.y - window.scrollY };
      if (cancelled) return;
      ghost.style.left = `${to.x}px`;
      ghost.style.top = `${to.y}px`;
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      const animation = ghost.animate(
        [
          { transform: shift(dx, dy, 0.9), opacity: 0 },
          { transform: shift(dx * 0.88, dy * 0.88, 1), opacity: 1, offset: 0.15 },
          { transform: shift(0, 0, 1), opacity: 1 },
        ],
        { duration: FLIGHT_MS, easing: "cubic-bezier(.22,.7,.2,1)", fill: "forwards" },
      );
      try {
        await animation.finished;
      } catch {
        // Cancelled because the screen moved on; the row is there regardless.
      }
      flashTheRow();
    })();
    return () => {
      cancelled = true;
    };
  }, [pending, onArrived]);

  return (
    <div ref={ref} className={classes.ghost} data-testid="hours-flight" aria-hidden="true">
      {pending.label}
    </div>
  );
}

/** Offset from the pill's resting place, which is centred on its row. */
const shift = (dx: number, dy: number, scale: number) =>
  `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${scale})`;

const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

const noMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll on animation frames until `get` finds something, or time runs out. */
async function waitFor<T>(get: () => T | null, ms = 1500): Promise<T | null> {
  const until = performance.now() + ms;
  for (;;) {
    const found = get();
    if (found) return found;
    if (performance.now() > until) return null;
    await frame();
  }
}

/**
 * Bring a row into view if it isn't, and wait for the scrolling to stop. A
 * smooth scroll's duration is the browser's business, so this watches the
 * rectangle settle rather than guessing at a delay.
 */
async function reveal(el: HTMLElement): Promise<DOMRect> {
  const rect = el.getBoundingClientRect();
  if (rect.top >= 0 && rect.bottom <= window.innerHeight) return rect;
  // `nearest`, not `center`: move the page as little as will do. Stopping a
  // timer shouldn't throw the screen away from the button just tapped.
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const started = performance.now();
  let last = rect.top;
  for (;;) {
    await frame();
    const now = performance.now();
    const top = el.getBoundingClientRect().top;
    const still = Math.abs(top - last) < 0.5;
    last = top;
    if ((still && now - started > 150) || now - started > 800) break;
  }
  return el.getBoundingClientRect();
}
