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
