import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  // Signed-out pages.
  route("signin", "routes/signin.tsx"),
  route("signout", "routes/signout.ts"),
  route("join/:token", "routes/join.$token.ts"),
  route("join", "routes/join.tsx"),

  // Everything behind sign-in shares the app chrome.
  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
    route("day/:date", "routes/_app.day.$date.tsx"),
    route("account", "routes/_app.account.tsx"),
    ...prefix("admin", [
      route("timesheets", "routes/_app.admin.timesheets.tsx"),
      route("calendar", "routes/_app.admin.calendar.tsx"),
      route("reports", "routes/_app.admin.reports.tsx"),
      route("jobs", "routes/_app.admin.jobs.tsx"),
      route("people", "routes/_app.admin.people.tsx"),
      route("people/:userId", "routes/_app.admin.people.$userId.tsx"),
      route("people/:userId/time/:date?", "routes/_app.admin.people.$userId.time.tsx"),
      route("rates", "routes/_app.admin.rates.tsx"),
    ]),
  ]),

  // Report downloads (no page chrome).
  route("admin/reports.csv", "routes/admin.reports.csv.ts"),

  // Every change to tracking data arrives here as an op.
  route("api/ops", "routes/api.ops.ts"),
  // ...or here, when an admin changes someone else's time.
  route("api/admin/people/:userId/ops", "routes/api.admin.people.$userId.ops.ts"),

  // JSON endpoints for the passkey ceremonies.
  ...prefix("api/passkey", [
    route("register-options", "routes/api.passkey.register-options.ts"),
    route("register-verify", "routes/api.passkey.register-verify.ts"),
    route("signin-options", "routes/api.passkey.signin-options.ts"),
    route("signin-verify", "routes/api.passkey.signin-verify.ts"),
  ]),

  // The manifest is generated rather than a static file in public/: its name,
  // short name and theme colour all come from the deployment's environment, so
  // the same image can be branded per install.
  route("manifest.webmanifest", "routes/manifest.ts"),
] satisfies RouteConfig;
