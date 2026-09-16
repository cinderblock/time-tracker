/**
 * Test preload (see bunfig.toml). `config` reads required variables at import
 * time, so they must exist before any test file loads a module that uses it.
 * Values already present in the environment win.
 */
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.SESSION_SECRET ??= "test-only-session-secret";
process.env.ACCOUNTING_BACKEND ??= "none";
// config.timezone is read once, at import; code that formats dates reads TZ at
// call time. Fix it here, before anything imports config, so the two agree.
process.env.TZ ??= "America/Los_Angeles";
