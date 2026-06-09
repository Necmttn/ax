import { describe, expect, test } from "bun:test";
import type { InspectTurnDto } from "@ax/lib/shared/dashboard-types";
import { pairImageAttachments } from "./image-pairing.ts";

const turn = (seq: number, raw_text: string, over: Partial<InspectTurnDto> = {}): InspectTurnDto => ({
    seq,
    role: "user",
    semantic_role: "user_input",
    ts: null,
    char_count: raw_text.length,
    raw_text,
    spans: [],
    token_usage: null,
    content: null,
    ...over,
});

describe("pairImageAttachments", () => {
    test("folds a following pure-attachment turn into the referencing message", () => {
        const turns = [
            turn(0, "[Image #1] Can we have alternative tool representation?"),
            turn(1, "[Image: source: /a/shot.png]"),
            turn(2, "ok", { role: "assistant", semantic_role: "assistant_text" }),
        ];
        const { imagePathsByTurn, consumedSeqs } = pairImageAttachments(turns);
        expect(imagePathsByTurn.get(0)).toEqual(["/a/shot.png"]);
        expect(imagePathsByTurn.has(1)).toBe(false);
        expect([...consumedSeqs]).toEqual([1]);
    });

    test("a pure-attachment as the FIRST turn stays standalone (not consumed)", () => {
        const turns = [
            turn(0, "[Image: source: /a/shot.png]"),
            turn(1, "follow up", { role: "assistant", semantic_role: "assistant_text" }),
        ];
        const { imagePathsByTurn, consumedSeqs } = pairImageAttachments(turns);
        expect(consumedSeqs.size).toBe(0);
        // The standalone attachment turn renders via its own fallback extraction,
        // so it is NOT given a merged entry here.
        expect(imagePathsByTurn.has(0)).toBe(false);
    });

    test("two attachment turns after one message → both folded + consumed", () => {
        const turns = [
            turn(0, "[Image #1] [Image #2] look at these"),
            turn(1, "[Image: source: /a/one.png]"),
            turn(2, "[Image: source: /b/two.jpg]"),
        ];
        const { imagePathsByTurn, consumedSeqs } = pairImageAttachments(turns);
        expect(imagePathsByTurn.get(0)).toEqual(["/a/one.png", "/b/two.jpg"]);
        expect([...consumedSeqs].sort()).toEqual([1, 2]);
    });

    test("message carrying its OWN source path with no following attachment maps, consumes nothing", () => {
        const turns = [
            turn(0, "here is one [Image: source: /a/inline.png] inline"),
            turn(1, "reply", { role: "assistant", semantic_role: "assistant_text" }),
        ];
        const { imagePathsByTurn, consumedSeqs } = pairImageAttachments(turns);
        expect(imagePathsByTurn.get(0)).toEqual(["/a/inline.png"]);
        expect(consumedSeqs.size).toBe(0);
    });

    test("a message's own path PLUS a following attachment merge onto the message", () => {
        const turns = [
            turn(0, "inline [Image: source: /a/inline.png] plus paste"),
            turn(1, "[Image: source: /b/paste.png]"),
        ];
        const { imagePathsByTurn, consumedSeqs } = pairImageAttachments(turns);
        expect(imagePathsByTurn.get(0)).toEqual(["/a/inline.png", "/b/paste.png"]);
        expect([...consumedSeqs]).toEqual([1]);
    });

    test("stops at the first non-pure turn (does not skip across prose)", () => {
        const turns = [
            turn(0, "[Image #1] msg"),
            turn(1, "[Image: source: /a/one.png]"),
            turn(2, "intervening prose", { role: "assistant", semantic_role: "assistant_text" }),
            turn(3, "[Image: source: /b/two.png]"),
        ];
        const { imagePathsByTurn, consumedSeqs } = pairImageAttachments(turns);
        expect(imagePathsByTurn.get(0)).toEqual(["/a/one.png"]);
        // turn 3 has no preceding anchor (turn 2 is prose, but turn 3 is a pure
        // attachment whose anchor would be turn 2). It folds onto turn 2.
        expect(imagePathsByTurn.get(2)).toEqual(["/b/two.png"]);
        expect([...consumedSeqs].sort()).toEqual([1, 3]);
    });

    test("turns with no images produce an empty pairing", () => {
        const turns = [turn(0, "hello"), turn(1, "world")];
        const { imagePathsByTurn, consumedSeqs } = pairImageAttachments(turns);
        expect(imagePathsByTurn.size).toBe(0);
        expect(consumedSeqs.size).toBe(0);
    });
});
