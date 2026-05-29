import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { OutcomesKey, outcomesStage } from "./outcomes.ts";

describe("outcomesStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(OutcomesKey)("outcomes")).toBe("outcomes");
        expect(outcomesStage.meta.key).toBe("outcomes");
        expect(outcomesStage.meta.deps).toEqual(["signals"]);
        expect(outcomesStage.meta.tags).toEqual(["derive"]);
    });
});
