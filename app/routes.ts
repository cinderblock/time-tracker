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
    route("account", "routes/_app.account.tsx"),
    ...prefix("admin", [
      route("people", "routes/_app.admin.people.tsx"),
      route("people/:userId", "routes/_app.admin.people.$userId.tsx"),
    ]),
  ]),

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
