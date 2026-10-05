import { execFileSync } from "node:child_process";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

/**
 * The commit being built: CI and the image build say it (APP_REVISION, from
 * the Dockerfile's REVISION argument); a local build asks git; with neither,
 * "dev". Baked into the code as __APP_REVISION__ (src/build-info.ts), so a
 * bug report can say exactly which code it came from.
 */
function revision(): string {
  if (process.env.APP_REVISION) return process.env.APP_REVISION;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [reactRouter()],
  define: {
    __APP_REVISION__: JSON.stringify(revision()),
    __APP_BUILT_AT__: JSON.stringify(Date.now()),
  },
  resolve: {
    // Vite 8 resolves tsconfig `paths` natively, so the `vite-tsconfig-paths`
    // plugin this project used to carry is gone.
    tsconfigPaths: true,
  },
  server: {
    port: Number(process.env.PORT ?? 3000),
  },
  ssr: {
    // src/ holds runtime-only server modules (SQLite, accounting backends).
    // Externalizing them keeps bun:sqlite out of the SSR bundle; the Dockerfile
    // copies src/ into the runtime image so they resolve there.
    external: ["bun:sqlite"],
  },
});
