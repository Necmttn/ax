import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { ClosureKey, ClosureStageStats, closureStage } from "./closure.ts";

describe("closureStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(ClosureKey)("closure")).toBe("closure");
        expect(closureStage.meta.key).toBe("closure");
        expect(closureStage.meta.deps).toEqual(["signals"]);
        expect(closureStage.meta.tags).toEqual(["derive"]);
    });
});
