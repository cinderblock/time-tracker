import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
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
