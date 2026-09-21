import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import classes from "./flight.module.css";

/**
 * Time seen moving from one column of the day to the other.
 *
 * When a change turns work into hours — a job's notes rolled up — the new row
 * is already on the right of the screen by the time the dialog closes, and it
 * simply appears there. `flyToEntry` sends a pill carrying the duration from
 * where the change was made to the row it became, and flashes the row as it
 * lands, so the flow is something you watch rather than something you work
 * out. Nothing depends on it finishing: the data is in place first, and a
 * person who asked for no motion just gets the flash.
 */

interface Flight {
  /**
   * Send `label` from `from` to the entry row `entryId`, then flash that row.
   * Call it once the change has succeeded, with the element the change was
   * made from; a missing or detached source only flashes the row.
   */
  flyToEntry(entryId: string, label: string, from: HTMLElement | null): void;
  /** The entry row that has just landed, if any. */
  landed: string | null;
}

interface Pending {
  entryId: string;
  label: string;
  from: HTMLElement;
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
 * The pill in flight. It measures both ends itself, at the moment it flies:
 * the page may have scrolled since the change was made, and on a phone the
 * row it is flying to is usually below the fold — so bring that into view
 * first, and let the scrolling finish before taking any measurement.
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
      const source = pending.from.getBoundingClientRect();
      // Detached between the change and the flight: nothing to fly from.
      if (source.width === 0 && source.height === 0) {
        flashTheRow();
        return;
      }
      const from = centre(source);
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
  el.scrollIntoView({ block: "center", behavior: "smooth" });
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
