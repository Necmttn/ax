/**
 * Default port for `ax serve` (the local dashboard daemon).
 *
 * Single source of truth so user-facing copy (the agent onboarding prompt,
 * ingest dry-run hint, CLI flag default) can't drift from the actual serve
 * default again. README.md, install.sh, and the landing site mirror this
 * value as plain text - if you change it, sweep those too
 * (`rg -n "1738" README.md install.sh apps/site`).
 */
export const DEFAULT_DASHBOARD_PORT = 1738;
