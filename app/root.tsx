import {
  ColorSchemeScript,
  MantineProvider,
  type MantineColorsTuple,
  createTheme,
  mantineHtmlProps,
} from "@mantine/core";
import { generateColors } from "@mantine/colors-generator";
import { Notifications } from "@mantine/notifications";
import { useEffect, useMemo } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";

import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";

import { config } from "../src/config.server.ts";
import { authMiddleware } from "./auth.server.ts";
import { initMiddleware } from "./server-init.ts";

// Order matters: the database must be open before the session is resolved.
// Middleware (unlike the root loader) also runs for the JSON API routes.
export const middleware: Route.MiddlewareFunction[] = [initMiddleware, authMiddleware];

/**
 * Branding reaches the client through the root loader rather than being
 * compiled in, so one image serves any deployment. Nothing secret goes here.
 *
 * The ten-shade ramp is generated on the server so the colour library stays
 * out of the browser bundle.
 */
export function loader() {
  return {
    branding: {
      name: config.branding.name,
      shortName: config.branding.shortName,
      themeColor: config.branding.themeColor,
      palette: [...generateColors(config.branding.themeColor)],
    },
  };
}

// Use the generated `Route.MetaArgs` rather than hand-writing this parameter's
// type. The field is `loaderData`; an earlier hand-rolled `{ data }` signature
// type-checked perfectly — because it was self-declared — and silently shipped
// the fallback title on every page.
export function meta({ loaderData }: Route.MetaArgs) {
  const name = loaderData?.branding.name ?? FALLBACK_NAME;
  return [
    { title: name },
    { name: "description", content: `${name} — track time, on or offline.` },
  ];
}

const FALLBACK_NAME = "Time Tracker";
const FALLBACK_THEME_COLOR = "#1c7ed6";

export function Layout({ children }: { children: React.ReactNode }) {
  // `useRouteLoaderData` rather than `useLoaderData`: Layout also wraps the
  // ErrorBoundary, and when the root loader itself failed there is no loader
  // data to read. This returns undefined instead of throwing.
  const data = useRouteLoaderData<typeof loader>("root");
  const themeColor = data?.branding.themeColor ?? FALLBACK_THEME_COLOR;
  const shortName = data?.branding.shortName ?? FALLBACK_NAME;

  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover so the layout can reach under the notch; the
            safe-area insets are respected in CSS rather than by letterboxing. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content={themeColor} />
        {/* iOS ignores the manifest's display mode; these make a home-screen
            launch open without Safari chrome, under the right name. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content={shortName} />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <ColorSchemeScript defaultColorScheme="auto" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  const { palette } = loaderData.branding;

  const theme = useMemo(
    () =>
      createTheme({
        primaryColor: "brand",
        colors: { brand: palette as unknown as MantineColorsTuple },
        // Pick black or white text per shade, so a light brand colour still
        // produces readable buttons.
        autoContrast: true,
        // Phone-first: bigger default hit targets than Mantine's desktop defaults.
        components: {
          Button: { defaultProps: { size: "md" } },
        },
      }),
    [palette],
  );

  useEffect(() => {
    // Registered from the client only; the worker is what makes the app
    // installable (and, from phase 3, usable offline).
    navigator.serviceWorker?.register("/sw.js").catch((err: unknown) => {
      console.warn("Service worker registration failed", err);
    });
  }, []);

  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="bottom-center" />
      <Outlet />
    </MantineProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  let heading = "Something went wrong";
  // Never surface a raw stack to a field employee; the server log has it.
  let detail = "The app hit an unexpected error. Your tracked time is safe.";
  if (isRouteErrorResponse(error)) {
    heading = error.status === 404 ? "Page not found" : error.status === 403 ? "Not allowed" : `Error ${error.status}`;
    detail =
      typeof error.data === "string" && error.data
        ? error.data
        : error.statusText || (error.status === 404 ? "There's nothing at this address." : detail);
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "36rem", margin: "0 auto" }}>
      <h1>{heading}</h1>
      <p>{detail}</p>
      <p>
        <a href="/">Back to the app</a>
      </p>
    </main>
  );
}
