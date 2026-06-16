/**
 * Repo-root mirror of apps/site/functions/og-duel: the Cloudflare Pages GIT
 * integration builds with the repository root as its project root, so it only
 * picks up THIS functions/ directory - without this re-export the duel OG
 * image (/og-duel/<a>/<b>) would be silently dropped from production and the
 * challenge share-card unfurl would 404. Keep both in sync by re-exporting,
 * never duplicating.
 */
export { onRequestGet } from "../../../apps/site/functions/og-duel/[a]/[b]";
