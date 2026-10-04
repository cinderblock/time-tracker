import { draftKey, useDraft } from "../drafts/drafts.ts";
import { useTracker } from "./context.tsx";

/**
 * `useDraft` for a field on the tracking screen: kept per person, and apart
 * for an admin working on someone's day, so neither ever sees the other's
 * half-typed text. `field` null keeps nothing.
 */
export function useTrackerDraft<T>(field: string | null, initial: T) {
  return useDraft(useTrackerDraftKey(field), initial);
}

/** The storage key a tracking-screen field's draft is kept under. */
export function useTrackerDraftKey(field: string | null): string | null {
  const { model, actingFor } = useTracker();
  const scope = actingFor ? `for-${model.userId}` : String(model.userId);
  return field ? draftKey(scope, field) : null;
}
