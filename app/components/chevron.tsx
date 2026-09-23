/**
 * The arrow on a navigation button, drawn here rather than pulled from an
 * icon package: two shapes is not a dependency, and these have to be sized in
 * props so they can grow with the button they sit in — the day header's were
 * text glyphs at text size, and too small to read as buttons at all.
 *
 * `double` is the week jump, the single one a day; a left-facing arrow is the
 * right-facing one mirrored, so there is one set of paths to keep honest.
 */
export function Chevron({
  towards,
  double = false,
  size = 20,
}: {
  towards: "left" | "right";
  double?: boolean;
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={towards === "left" ? { transform: "scaleX(-1)" } : undefined}
    >
      {double ? (
        <>
          <path d="m5 5 7 7-7 7" />
          <path d="m13 5 7 7-7 7" />
        </>
      ) : (
        <path d="m9 5 7 7-7 7" />
      )}
    </svg>
  );
}
