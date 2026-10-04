import { Anchor, Text, type TextProps } from "@mantine/core";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Text that may run long — a note — shown a few lines deep, with the rest a
 * tap away.
 *
 * The cut ends in an ellipsis, and "Show all" appears only when something was
 * actually cut, so a short note looks exactly as it would without this. The
 * control is a button of its own rather than "tap the row", because a row may
 * be locked (submitted time can't be opened for editing) and the note still
 * has to be readable in full. Line breaks the person typed are kept.
 *
 * Whether anything was cut is measured, not guessed from the length: it
 * depends on the width, so it is measured again whenever the text's box
 * changes size.
 */
export function ClampedText({ children, lines, ...props }: Omit<TextProps, "lineClamp"> & { children: string; lines: number }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();

  useEffect(() => {
    const el = ref.current;
    // Opened, nothing is cut, but the control stays to close it again.
    if (!el || open) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, lines, open]);

  return (
    <div>
      <Text
        ref={ref}
        id={id}
        lineClamp={open ? undefined : lines}
        style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}
        {...props}
      >
        {children}
      </Text>
      {(cut || open) && (
        <Anchor component="button" type="button" size="xs" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={id}>
          {open ? "Show less" : "Show all"}
        </Anchor>
      )}
    </div>
  );
}
