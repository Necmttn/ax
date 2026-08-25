import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { GitKey, gitStage } from "./git.ts";
import { ALL_STAGES } from "./stage/registry.ts";

describe("gitStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(GitKey)("git")).toBe("git");
        expect(gitStage.meta.key).toBe("git");
        // #684: gitStage must wait for every session-writing provider stage
        // that precedes it in ALL_STAGES, so a warm run (unchanged git
        // watermark) still sees the sessions those stages just wrote before
        // it correlates produced edges. The subagent parser also writes
        // sessions. The runner only awaits deps present in the selected stage
        // set, so listing all seven is safe even when a
        // caller runs a stage subset that omits some of them.
        const gitIndex = ALL_STAGES.findIndex((stage) => stage.meta.key === "git");
        const precedingSessionWriters = ALL_STAGES
            .slice(0, gitIndex)
            .filter((stage) => stage.meta.writes.some((write) => write.table === "session" && write.mode === "parse"))
            .map((stage) => stage.meta.key);
        expect(gitStage.meta.deps).toEqual(precedingSessionWriters);
        expect(gitStage.meta.tags).toEqual(["ingest"]);
    });
});
