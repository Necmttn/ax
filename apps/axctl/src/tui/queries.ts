/**
 * SurrealQL query strings used by the TUI dashboard.
 *
 * All SQL now lives in `src/queries/` so every surface shares one variant.
 * Re-exported here for backward compatibility with the TUI hooks.
 */

export {
    PRODUCED_BY_SESSION_SQL,
    SKILL_LAST_PROJECT_SQL,
    SKILL_SUMMARY_PROPOSED_ONLY_SQL,
    SKILL_SUMMARY_SQL,
} from "../queries/skill-summary.ts";

// The TUI DetailPane re-queries per (debounced) row selection, so it gets the
// lightweight variant - the full SKILL_DETAIL_SQL adds dashboard evidence
// blocks (corrections/proposals/paired) the TUI never renders, and `paired`
// scans skill_paired by both endpoints (unindexed).
export { SKILL_DETAIL_BASIC_SQL as SKILL_DETAIL_SQL } from "../queries/skill-detail.ts";
