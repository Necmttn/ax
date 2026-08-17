/**
 * Query strings used by the TUI dashboard.
 *
 * All SQL lives in `src/queries/` so every surface shares one variant;
 * re-exported here for the TUI hooks.
 */

export {
    PRODUCED_BY_SESSION_SQL,
    SKILL_LAST_PROJECT_SQL,
    SKILL_SUMMARY_PROPOSED_ONLY_SQL,
    SKILL_SUMMARY_SQL,
} from "../queries/skill-summary.ts";
