import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { ClaudeKey, claudeStage } from "./transcripts.ts";

describe("claudeStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(ClaudeKey)("claude")).toBe("claude");
        expect(claudeStage.meta.key).toBe("claude");
        expect(claudeStage.meta.deps).toEqual(["skills", "commands"]);
        expect(claudeStage.meta.tags).toEqual(["ingest"]);
    });
});
