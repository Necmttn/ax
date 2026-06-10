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

export { SKILL_DETAIL_SQL } from "../queries/skill-detail.ts";
