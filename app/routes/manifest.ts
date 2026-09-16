import { config } from "../../src/config.server.ts";

/**
 * The PWA manifest, generated from the deployment's branding config.
 *
 * Icons are intentionally referenced by fixed paths under /icons/. A
 * deployment that wants its own logo bind-mounts them there; the repo ships
 * generic placeholders so an unbranded install is still installable.
 */
export function loader() {
  const manifest = {
    name: config.branding.name,
    short_name: config.branding.shortName,
    description: `${config.branding.name} — track time, on or offline.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Portrait-only would be wrong: the admin weekly calendar is genuinely
    // better in landscape on a tablet.
    orientation: "any",
    background_color: "#ffffff",
    theme_color: config.branding.themeColor,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      "Content-Type": "application/manifest+json",
      // Short cache: branding changes should show up on the next launch, but
      // this shouldn't be re-fetched on every navigation either.
      "Cache-Control": "public, max-age=300",
    },
  });
}
