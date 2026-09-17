import { beforeEach, describe, expect, test } from "bun:test";

import { auditFor } from "./audit.ts";
import { branding, brandingDefaults, normalizeColor, setBranding } from "./branding.ts";
import { freshDb } from "./testing/db.ts";
import { createUser } from "./users.ts";

let admin = 0;

beforeEach(() => {
  freshDb();
  admin = createUser({ name: "Ada", role: "admin", actorUserId: null }).id;
});

describe("branding", () => {
  test("starts as the deployment's defaults", () => {
    expect(branding()).toEqual(brandingDefaults());
    expect(branding()).toEqual({ name: "Time Tracker", shortName: "Time", themeColor: "#1c7ed6" });
  });

  test("admins change it; blank goes back to the default; each change is audited", () => {
    expect(setBranding({ name: "  Crew   Hours ", shortName: "Hours", themeColor: "#0CA678" }, admin)).toEqual({
      name: "Crew Hours",
      shortName: "Hours",
      themeColor: "#0ca678",
    });
    // A partial change leaves the rest alone.
    setBranding({ themeColor: "e8590c" }, admin);
    expect(branding()).toEqual({ name: "Crew Hours", shortName: "Hours", themeColor: "#e8590c" });

    setBranding({ name: "", shortName: " ", themeColor: "" }, admin);
    expect(branding()).toEqual(brandingDefaults());
    expect(auditFor("setting", "branding_name").map((e) => e.after_json)).toEqual(['"Crew Hours"', '""']);
  });

  test("bad values are refused with a reason", () => {
    expect(() => setBranding({ themeColor: "blue" }, admin)).toThrow("Pick a colour");
    expect(() => setBranding({ name: "x".repeat(61) }, admin)).toThrow("limited to 60");
    expect(() => setBranding({ shortName: "Thirteen chars" }, admin)).toThrow("limited to 12");
    expect(branding()).toEqual(brandingDefaults());
  });

  test("colour forms", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor(" 1c7ed6 ")).toBe("#1c7ed6");
    expect(() => normalizeColor("#12345")).toThrow();
  });
});
