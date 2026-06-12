/**
 * Repo-root mirror of apps/site/functions/og-profile: the Cloudflare Pages GIT
 * integration builds with the repository root as its project root, so it only
 * picks up THIS functions/ directory - every auto-build was shipping without
 * the OG poster + share-meta functions and silently wiping them from
 * production (manual `wrangler pages deploy` runs from apps/site and uses
 * apps/site/functions). Keep both in sync by re-exporting, never duplicating.
 */
export { onRequestGet } from "../../apps/site/functions/og-profile/[login]";
