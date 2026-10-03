import { Button, Group, Text } from "@mantine/core";

import appear from "../components/appear.module.css";
import { useTracker } from "./context.tsx";
import classes from "./UndoLine.module.css";

/**
 * The way back from the last change, under the day header: "Undo stopping
 * the timer". One line of fixed height whether or not there is anything to
 * undo, so the page doesn't shift as changes are made and unmade. Ctrl/Cmd+Z
 * does the same from the keyboard (context.tsx); the delete toasts offer it
 * too, for the change they announce.
 */
export function UndoLine() {
  const { undoable, undo, pending } = useTracker();
  return (
    <Group className={classes.line} justify="flex-end" gap="xs" wrap="nowrap">
      {undoable && (
        <Button
          key={undoable.label}
          className={appear.appear}
          variant="subtle"
          size="compact-sm"
          leftSection={<UndoArrow />}
          disabled={pending}
          onClick={() => void undo()}
          aria-keyshortcuts="Control+Z Meta+Z"
        >
          <Text component="span" size="sm" inherit truncate>
            Undo {undoable.label}
          </Text>
        </Button>
      )}
    </Group>
  );
}

/** A counter-clockwise arrow, drawn here rather than pulled from an icon package. */
function UndoArrow() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </svg>
  );
}
