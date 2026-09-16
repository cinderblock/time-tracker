/**
 * Page titles. A route's `meta` replaces its parents' entirely, so each page
 * builds "Page · App name" itself, reading the app name from the root
 * loader's data in `matches`.
 */
export function pageTitle(matches: readonly ({ id: string; loaderData: unknown } | undefined)[], page: string) {
  const root = matches.find((m) => m?.id === "root")?.loaderData as { branding?: { name?: string } } | undefined;
  const app = root?.branding?.name;
  return [{ title: app ? `${page} · ${app}` : page }];
}
