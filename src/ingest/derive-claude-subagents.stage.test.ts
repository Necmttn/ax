import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { SubagentsKey, SubagentsStats, subagentsStage } from "./derive-claude-subagents.ts";

describe("subagentsStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(SubagentsKey)("subagents")).toBe("subagents");
        expect(subagentsStage.meta.key).toBe("subagents");
        expect(subagentsStage.meta.deps).toEqual(["claude", "codex"]);
        expect(subagentsStage.meta.tags).toEqual(["derive"]);
    });
});
