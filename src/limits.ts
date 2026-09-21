/**
 * Input limits shared by the server's validation and the browser's form fields.
 *
 * This module must stay dependency-free: page components import it, and
 * anything it imported would be shipped to the browser. The server-side
 * modules that enforce these (users.ts, credentials.ts) sit on top of the
 * database, which the build refuses to bundle for the client.
 */
export const NAME_MAX_LENGTH = 80;
export const NICKNAME_MAX_LENGTH = 60;
/** Notes on time entries and day notes. Long enough for a paragraph. */
export const NOTE_MAX_LENGTH = 2000;
export const JOB_NAME_MAX_LENGTH = 120;
export const CATEGORY_NAME_MAX_LENGTH = 60;
/** The app's name, and the short one under its home-screen icon (12 fits every launcher). */
export const BRANDING_LIMITS = { name: 60, shortName: 12 } as const;
/** Hourly rates are money per hour; anything above this is a typo. */
export const MAX_HOURLY_RATE = 100_000;
/** One entry covers at most a day — a longer one is a slip, not a shift. */
export const MAX_ENTRY_SECONDS = 24 * 3600;
