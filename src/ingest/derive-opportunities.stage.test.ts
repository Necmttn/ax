import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { OpportunitiesKey, opportunitiesStage } from "./derive-opportunities.ts";

describe("opportunitiesStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(OpportunitiesKey)("opportunities")).toBe("opportunities");
        expect(opportunitiesStage.meta.key).toBe("opportunities");
        expect(opportunitiesStage.meta.deps).toEqual(["proposals"]);
        expect(opportunitiesStage.meta.tags).toEqual(["derive"]);
    });
});
