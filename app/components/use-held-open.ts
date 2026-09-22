import { useRef } from "react";

/**
 * What a dialog goes on showing while it fades out.
 *
 * A dialog whose subject is a nullable prop — the entry being edited, the job
 * being switched to, the link just minted — is closed by clearing that prop,
 * which is also what clears `opened`. But Mantine keeps a modal mounted for
 * its exit transition, so for those ~200ms the dialog renders with its
 * subject already gone: "Edit entry" turns into the "Add time" form,
 * "switches to Bravo" into "switches to ", and the link dialog into an empty
 * box. The close reads as a glitch.
 *
 * Holding the last subject for as long as the dialog is still on screen fixes
 * that where it happens — in the render — rather than by delaying the state
 * change behind a timer that would then have to be kept in step with the
 * animation's duration.
 *
 * The ref is written during render on purpose: the held value has to be right
 * in the very render where `opened` goes false, which an effect is too late
 * for. It is the same escape hatch `EntryEditor` already uses to keep a data
 * refresh from wiping what's been typed.
 */
export function useHeldOpen<T>(opened: boolean, subject: T): T {
  const held = useRef(subject);
  if (opened) held.current = subject;
  return held.current;
}
