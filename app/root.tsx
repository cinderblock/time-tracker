import {
  ColorSchemeScript,
  MantineProvider,
  createTheme,
  mantineHtmlProps,
} from "@mantine/core";
import { Notifications } from "@mantine/notifications";
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
import "@mantine/notifications/styles.css";

import { config } from "../src/config.ts";
import { ensureServerInit } from "./server-init.ts";

/**
 * Branding reaches the client through a root loader rather than being compiled
 * in, so one image serves any deployment. Nothing secret goes through here.
 *
 * The root loader also runs startup: it is the one loader guaranteed to run
 * before any other, so the database is open and migrated by the time a child
 * route's loader touches it.
 */
export function loader() {
  ensureServerInit();
  return {
    branding: {
      name: config.branding.name,
      shortName: config.branding.shortName,
      themeColor: config.branding.themeColor,
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

  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover so the layout can reach under the notch; the
            safe-area insets are respected in CSS rather than by letterboxing. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="theme-color" content={themeColor} />
        {/* iOS ignores the manifest's display mode; this is what makes a
            home-screen launch open without Safari chrome. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <ColorSchemeScript />
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
  const { branding } = loaderData;

  const theme = createTheme({
    primaryColor: "brand",
    colors: {
      // Mantine wants ten shades. Rather than ship a hand-tuned ramp that only
      // suits one brand colour, every slot takes the configured colour and the
      // component library's own alpha handling provides the variation. A
      // deployment that wants a real ramp can replace this wholesale.
      brand: Array.from({ length: 10 }, () => branding.themeColor) as unknown as [
        string, string, string, string, string, string, string, string, string, string,
      ],
    },
    // Phone-first: bigger default hit targets than Mantine's desktop defaults.
    components: {
      Button: { defaultProps: { size: "md" } },
    },
  });

  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="bottom-center" />
      <Outlet />
    </MantineProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  const { heading, detail } = isRouteErrorResponse(error)
    ? { heading: `${error.status}`, detail: error.statusText || "Something went wrong." }
    : {
        heading: "Something went wrong",
        // Never surface a raw stack to a field employee; the server log has it.
        detail: "The app hit an unexpected error. Your tracked time is safe.",
      };

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>{heading}</h1>
      <p>{detail}</p>
      <p>
        <a href="/">Back to the app</a>
      </p>
    </main>
  );
}
