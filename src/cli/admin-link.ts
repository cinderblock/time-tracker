/**
 * Print a one-time admin registration link.
 *
 *   bun run admin-link              (locally)
 *   docker exec <container> bun run admin-link
 *
 * For a missed first-run log line, or recovery when every admin has lost their
 * passkeys. With no admin yet it mints a bootstrap link; otherwise an admin
 * invite, which creates a *new* admin person — existing people get back in
 * through an add_device link minted from the People page.
 *
 * Prints only the URL on stdout, so scripts (and the e2e test) can capture it.
 */
import { initDb } from "../db.server.ts";
import { mintRegistration } from "../registrations.ts";
import { countActiveAdmins } from "../users.ts";

// Diagnostics go to stderr; stdout carries nothing but the URL.
initDb(undefined, (line) => console.error(line));

const hasAdmin = countActiveAdmins() > 0;
const { url, registration } = mintRegistration(
  hasAdmin
    ? { purpose: "invite", role: "admin", createdBy: null, nameHint: null }
    : { purpose: "bootstrap", createdBy: null },
);

console.error(
  `${hasAdmin ? "Admin invite" : "First-admin setup"} link, valid until ` +
    `${new Date(registration.expiresAt).toISOString()}:`,
);
console.log(url);
