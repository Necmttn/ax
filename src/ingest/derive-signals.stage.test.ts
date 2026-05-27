import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { SignalsKey, SignalsStats, signalsStage } from "./derive-signals.ts";

describe("signalsStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(SignalsKey)("signals")).toBe("signals");
        expect(signalsStage.meta.key).toBe("signals");
        expect(signalsStage.meta.deps).toEqual(["claude", "codex", "subagents", "spawned", "git"]);
        expect(signalsStage.meta.tags).toEqual(["derive"]);
    });
});
