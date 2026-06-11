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

    it("ProposalsStats schema includes routingProposals field", () => {
        const stats = ProposalsStats.make({
            durationMs: 100,
            summary: "test",
            skillProposals: 2,
            guidanceProposals: 1,
            routingProposals: 1,
        });
        expect(stats.routingProposals).toBe(1);
        expect(stats.skillProposals).toBe(2);
        expect(stats.guidanceProposals).toBe(1);
    });
});
