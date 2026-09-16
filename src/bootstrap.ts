import { countActiveAdmins } from "./users.ts";
import { mintRegistration, revokeUnusedBootstrapLinks } from "./registrations.ts";

/**
 * First-run setup.
 *
 * While no active admin exists, every start revokes any unused bootstrap link
 * and prints a fresh one. Tokens are stored only as hashes, so an earlier link
 * can't be re-printed — minting anew is what guarantees the latest log always
 * holds a working link, instead of the link being lost with a missed log line.
 *
 * Returns the URL it printed, or null when an admin already exists.
 */
export function ensureBootstrapLink(log: (line: string) => void = console.log): string | null {
  if (countActiveAdmins() > 0) return null;

  revokeUnusedBootstrapLinks();
  const { url, registration } = mintRegistration({ purpose: "bootstrap", createdBy: null });

  const rule = "=".repeat(72);
  log("");
  log(rule);
  log("  FIRST-RUN SETUP — no admin exists yet.");
  log("  Open this one-time link to create the first admin and their passkey:");
  log("");
  log(`    ${url}`);
  log("");
  log(`  Valid until ${new Date(registration.expiresAt).toISOString()}.`);
  log("  A fresh link is printed on every restart until setup is done;");
  log("  `bun run admin-link` prints one on demand.");
  log(rule);
  log("");
  return url;
}
