import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),

  // The manifest is generated rather than a static file in public/: its name,
  // short name and theme colour all come from the deployment's environment, so
  // the same image can be branded per install.
  route("manifest.webmanifest", "routes/manifest.ts"),
] satisfies RouteConfig;
