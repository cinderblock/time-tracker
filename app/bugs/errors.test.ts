import { describe, expect, test } from "bun:test";

import { consoleText } from "./errors.ts";

describe("a console call as the line it prints", () => {
  test("styling is dropped with its CSS; other directives are filled in", () => {
    expect(consoleText(["%cWarning%c the thing broke", "font-weight: bold", "", "extra"])).toBe("Warning the thing broke extra");
    expect(consoleText(["%s failed after %d tries (100%%)", "Sync", 3])).toBe("Sync failed after 3 tries (100%)");
  });

  test("errors by their message, objects as JSON, a directive with nothing to fill left as it is", () => {
    expect(consoleText(["Saving:", new Error("offline"), { code: 7 }])).toBe("Saving: offline {\"code\":7}");
    expect(consoleText(["%s and %s", "one"])).toBe("one and %s");
    expect(consoleText([new TypeError("boom")])).toBe("boom");
  });
});
