import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { RetroProposalsKey, RetroProposalsStats, retroProposalsStage } from "./derive-retro-proposals.ts";

describe("retroProposalsStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(RetroProposalsKey)("retro-proposals")).toBe("retro-proposals");
        expect(retroProposalsStage.meta.key).toBe("retro-proposals");
        expect(retroProposalsStage.meta.deps).toEqual(["proposals"]);
        expect(retroProposalsStage.meta.tags).toEqual(["derive", "retro"]);
    });
});
