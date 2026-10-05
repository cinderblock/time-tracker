import { useEffect, useRef, useState } from "react";

import { shellCopy } from "../offline/storage.ts";
import { gatherContext } from "./context.ts";
import { reportError } from "./errors.ts";
import { sendReport } from "./report.ts";

/**
 * On the page that replaces the app when it crashes: the error is reported on
 * its own, and the person can add what they were doing. Plain HTML — the
 * theme and its components are part of what may have just failed.
 */
export function BoundaryReport({ error }: { error: unknown }) {
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    reportError(error, "boundary", "The page crashed");
  }, [error]);

  const user = typeof window === "undefined" ? null : shellCopy.read();
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">("idle");
  if (!user) return <p>This error has been reported.</p>;

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim() || !user) return;
    setState("sending");
    const context = await gatherContext(user.userId).catch(() => ({}));
    const result = await sendReport({
      userId: user.userId,
      pressedAt: Date.now(),
      description: text,
      expected: "",
      context: { ...context, crash: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) },
      shots: [],
    });
    setState(result.status === "sent" || result.status === "queued" ? "done" : "failed");
  }

  if (state === "done") return <p>Thanks — your note was sent with the error report.</p>;
  return (
    <form onSubmit={(e) => void send(e)} style={{ display: "grid", gap: "0.5rem", margin: "1rem 0" }}>
      <label htmlFor="crash-note">This error has been reported. What were you doing when it happened?</label>
      <textarea id="crash-note" rows={3} value={text} onChange={(e) => setText(e.currentTarget.value)} style={{ font: "inherit", padding: "0.5rem" }} />
      <div>
        <button type="submit" disabled={!text.trim() || state === "sending"}>
          {state === "sending" ? "Sending…" : "Send"}
        </button>
      </div>
      {state === "failed" && <p role="alert">That didn't send. Try again in a moment.</p>}
    </form>
  );
}
