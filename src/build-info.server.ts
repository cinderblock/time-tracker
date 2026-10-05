import { readFileSync } from "node:fs";

import { CODE_BUILD } from "./build-info.ts";

/**
 * The build the server is running: its commit and build time (from
 * `build/build-info.json`, written by scripts/finalize-build.ts), and the
 * build id the service worker carries — the hash of the built asset names,
 * which is what decides when a phone updates. Read once.
 */
export interface ServerBuild {
  revision: string;
  builtAt: number | null;
  buildId: string;
}

let cached: ServerBuild | null = null;

export function serverBuild(): ServerBuild {
  if (cached) return cached;
  try {
    const info = JSON.parse(readFileSync("build/build-info.json", "utf8")) as Partial<ServerBuild>;
    cached = {
      revision: info.revision || CODE_BUILD.revision,
      builtAt: info.builtAt ?? CODE_BUILD.builtAt,
      buildId: info.buildId || "dev",
    };
  } catch {
    cached = { revision: CODE_BUILD.revision, builtAt: CODE_BUILD.builtAt, buildId: "dev" };
  }
  return cached;
}
