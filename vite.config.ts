import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
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
