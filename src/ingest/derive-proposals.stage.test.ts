import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { ProposalsKey, ProposalsStats, proposalsStage } from "./derive-proposals.ts";

describe("proposalsStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(ProposalsKey)("proposals")).toBe("proposals");
        expect(proposalsStage.meta.key).toBe("proposals");
        expect(proposalsStage.meta.deps).toEqual(["closure"]);
        expect(proposalsStage.meta.tags).toEqual(["derive"]);
    });
});
