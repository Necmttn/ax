import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { HarnessKey, harnessStage } from "./harness.ts";

describe("harnessStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(HarnessKey)("harness")).toBe("harness");
        expect(harnessStage.meta.key).toBe("harness");
        expect(harnessStage.meta.deps).toEqual(["outcomes", "session-health", "closure"]);
        expect(harnessStage.meta.tags).toEqual(["derive", "health"]);
    });
});
