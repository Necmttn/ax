import { describe, expect, test } from "bun:test";
import { parserFingerprintPart, selectContentParser } from "./registry.ts";
import type { ContentParser } from "./types.ts";

const parser = (
    id: string,
    decision: "accept" | "maybe" | "reject",
    score: number,
): ContentParser => ({
    id,
    version: "1.0.0",
    accepts: () => ({ decision, score, reason: `${id} ${decision}` }),
    parse: () => ({ parserId: id, parserVersion: "1.0.0", blocks: [], atoms: [] }),
});

describe("content parser registry", () => {
    test("selects the highest scoring non-rejected parser", () => {
        const selected = selectContentParser([
            parser("generic-markdown", "maybe", 0.4),
            parser("gsd-plan", "accept", 0.9),
            parser("skill", "reject", 1),
        ], {
            sourceKind: "artifact",
            sourceRef: "fixture",
            text: "# fixture",
        });

        expect(selected?.parser.id).toBe("gsd-plan");
        expect(selected?.decision.reason).toBe("gsd-plan accept");
    });

    test("uses registry order as tie breaker", () => {
        const selected = selectContentParser([
            parser("first", "maybe", 0.5),
            parser("second", "accept", 0.5),
        ], {
            sourceKind: "artifact",
            sourceRef: "fixture",
            text: "# fixture",
        });

        expect(selected?.parser.id).toBe("first");
    });

    test("returns null when every parser rejects", () => {
        const selected = selectContentParser([parser("nope", "reject", 1)], {
            sourceKind: "artifact",
            sourceRef: "fixture",
            text: "# fixture",
        });

        expect(selected).toBeNull();
    });

    test("fingerprint part includes parser id and version", () => {
        expect(parserFingerprintPart({ id: "gsd-plan", version: "1.2.3" }))
            .toBe("gsd-plan@1.2.3");
    });
});
