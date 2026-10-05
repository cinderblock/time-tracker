/**
 * Which build this code is: the git commit it was built from, and when.
 *
 * In the browser (and the server bundle) Vite writes these in at build time
 * (`define` in vite.config.ts), so a page knows its own build however long
 * it has been open — a tab left open across a deploy runs the old code, and
 * says so. Run from source (tests, the operator CLI) there is no build: the
 * commit comes from the environment the image sets, or is "dev".
 *
 * Dependency-free: the browser imports this.
 */

declare const __APP_REVISION__: string | undefined;
declare const __APP_BUILT_AT__: number | undefined;

export interface BuildIdentity {
  /** The git commit, in full; "dev" when built outside a checkout or CI. */
  revision: string;
  /** When the build ran (epoch ms); null when not built. */
  builtAt: number | null;
}

export const CODE_BUILD: BuildIdentity = {
  revision:
    typeof __APP_REVISION__ === "string"
      ? __APP_REVISION__
      : (typeof process !== "undefined" ? process.env.APP_REVISION : undefined) || "dev",
  builtAt: typeof __APP_BUILT_AT__ === "number" ? __APP_BUILT_AT__ : null,
};

/** A commit as people write it: the first seven characters. */
export const shortRevision = (revision: string): string => (/^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 7) : revision);
