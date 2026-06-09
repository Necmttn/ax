import { describe, expect, test } from "bun:test";
import {
    WORKFLOW_EPISODE_SUBAGENT_INVOCATIONS_SQL,
    WORKFLOW_SESSION_SEQUENCES_SQL,
    WORKFLOW_SNAPSHOT_SQL,
} from "./workflow.ts";

describe("workflow queries", () => {
    test("reads the endpoint payload from a precomputed snapshot", () => {
        expect(WORKFLOW_SNAPSHOT_SQL).toContain("FROM workflow_snapshot:latest");
        expect(WORKFLOW_SNAPSHOT_SQL).toContain("payload");
    });

    test("shape queries use first-skill summaries instead of global invocation replays", () => {
        expect(WORKFLOW_SESSION_SEQUENCES_SQL).toContain("is_first = true");
        expect(WORKFLOW_SESSION_SEQUENCES_SQL).toContain("turn_index");
        expect(WORKFLOW_SESSION_SEQUENCES_SQL).not.toContain("ORDER BY session ASC, ts ASC");

        expect(WORKFLOW_EPISODE_SUBAGENT_INVOCATIONS_SQL).toContain("is_first = true");
        expect(WORKFLOW_EPISODE_SUBAGENT_INVOCATIONS_SQL).not.toContain("ORDER BY ts ASC");
    });
});
