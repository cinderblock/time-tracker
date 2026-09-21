import { describe, expect, test } from "bun:test";

import { jobLabel, jobPath, jobPathParts } from "./job-names.ts";

describe("job names on screen", () => {
  test("a path is its steps, outermost first", () => {
    expect(jobPathParts("Riverside:Phase 1:Deck")).toEqual(["Riverside", "Phase 1", "Deck"]);
    expect(jobPathParts("Riverside")).toEqual(["Riverside"]);
  });

  test("jobPath is the job's own name and the place above it", () => {
    expect(jobPath("Riverside:Phase 1:Deck")).toEqual({ name: "Deck", above: "Riverside › Phase 1" });
    expect(jobPath("Riverside:Phase 1")).toEqual({ name: "Phase 1", above: "Riverside" });
    // A customer has nothing above it.
    expect(jobPath("Riverside")).toEqual({ name: "Riverside", above: null });
  });

  test("jobLabel writes the whole path on one line, never with a colon", () => {
    expect(jobLabel("Riverside:Phase 1:Deck")).toBe("Riverside › Phase 1 › Deck");
    expect(jobLabel("Riverside")).toBe("Riverside");
    expect(jobLabel("Riverside:Phase 1:Deck")).not.toContain(":");
  });
});
