import { describe, expect, test } from "bun:test";
import {
    isNarrationAnchor,
    isNarrationStop,
    isSessionNarration,
    type SessionNarration,
} from "./narration-types.ts";
import { sampleNarration } from "./narration-sample.ts";

/** Deep-clone the sample so tests can mutate freely. */
const clone = (): SessionNarration => JSON.parse(JSON.stringify(sampleNarration));

describe("isSessionNarration", () => {
    test("accepts the hand-written sample narration", () => {
        expect(isSessionNarration(sampleNarration)).toBe(true);
    });

    test("accepts the sample after a JSON round-trip (file format)", () => {
        expect(isSessionNarration(JSON.parse(JSON.stringify(sampleNarration)))).toBe(true);
    });

    test("rejects null / non-objects / arrays", () => {
        expect(isSessionNarration(null)).toBe(false);
        expect(isSessionNarration(undefined)).toBe(false);
        expect(isSessionNarration("narration")).toBe(false);
        expect(isSessionNarration([sampleNarration])).toBe(false);
    });

    test("rejects wrong schema_version or kind", () => {
        expect(isSessionNarration({ ...clone(), schema_version: 2 })).toBe(false);
        expect(isSessionNarration({ ...clone(), kind: "manifest" })).toBe(false);
    });

    test("rejects missing or malformed meta", () => {
        const noMeta = clone() as Record<string, unknown>;
        delete noMeta.meta;
        expect(isSessionNarration(noMeta)).toBe(false);

        expect(isSessionNarration({
            ...clone(),
            meta: { session_id: "", generated_at: "2026-06-10T23:41:00Z", generator: "skill", model: "m" },
        })).toBe(false);

        expect(isSessionNarration({
            ...clone(),
            meta: { session_id: "s1", generated_at: "2026-06-10T23:41:00Z", generator: "cron", model: "m" },
        })).toBe(false);
    });

    test("rejects an empty stops array", () => {
        expect(isSessionNarration({ ...clone(), stops: [] })).toBe(false);
    });

    test("rejects a stop with no anchors", () => {
        const bad = clone() as { stops: Array<{ anchors: unknown[] }> };
        bad.stops[0]!.anchors = [];
        expect(isSessionNarration(bad)).toBe(false);
    });

    test("rejects a stop with an unknown anchor kind", () => {
        const bad = clone() as { stops: Array<{ anchors: unknown[] }> };
        bad.stops[0]!.anchors.push({ kind: "screenshot", path: "x.png" });
        expect(isSessionNarration(bad)).toBe(false);
    });
});

describe("isNarrationStop", () => {
    test("requires title, gist, detail, transition string, non-empty anchors", () => {
        const stop = clone().stops[0]!;
        expect(isNarrationStop(stop)).toBe(true);
        expect(isNarrationStop({ ...stop, gist: "" })).toBe(false);
        expect(isNarrationStop({ ...stop, transition: undefined })).toBe(false);
        expect(isNarrationStop({ ...stop, anchors: "none" })).toBe(false);
    });

    test("transition may be empty string (last stop)", () => {
        const last = clone().stops.at(-1)!;
        expect(last.transition).toBe("");
        expect(isNarrationStop(last)).toBe(true);
    });
});

describe("isNarrationAnchor", () => {
    test("file_hunk: needs file, label, and at least one non-empty side", () => {
        expect(isNarrationAnchor({
            kind: "file_hunk", file: "a.ts", old_text: null, new_text: "x", label: "adds x",
        })).toBe(true);
        expect(isNarrationAnchor({
            kind: "file_hunk", file: "a.ts", old_text: "x", new_text: null, label: "removes x", turn_seq: 3,
        })).toBe(true);
        // Both sides empty = no provenance.
        expect(isNarrationAnchor({
            kind: "file_hunk", file: "a.ts", old_text: null, new_text: null, label: "ghost",
        })).toBe(false);
        expect(isNarrationAnchor({
            kind: "file_hunk", file: "", old_text: null, new_text: "x", label: "no file",
        })).toBe(false);
        expect(isNarrationAnchor({
            kind: "file_hunk", file: "a.ts", old_text: null, new_text: "x", label: "bad seq", turn_seq: "3",
        })).toBe(false);
    });

    test("turn: needs numeric turn_seq and label", () => {
        expect(isNarrationAnchor({ kind: "turn", turn_seq: 4, label: "panel lands" })).toBe(true);
        expect(isNarrationAnchor({ kind: "turn", turn_seq: "4", label: "panel lands" })).toBe(false);
        expect(isNarrationAnchor({ kind: "turn", turn_seq: 4, label: "" })).toBe(false);
    });

    test("user_direction: needs turn_seq and quote", () => {
        expect(isNarrationAnchor({ kind: "user_direction", turn_seq: 14, quote: "do the thing" })).toBe(true);
        expect(isNarrationAnchor({ kind: "user_direction", turn_seq: 14, quote: "" })).toBe(false);
    });

    test("correction: needs quote AND outcome", () => {
        expect(isNarrationAnchor({
            kind: "correction", turn_seq: 9, quote: "not counts, chars", outcome: "diffstat fields added",
        })).toBe(true);
        expect(isNarrationAnchor({ kind: "correction", turn_seq: 9, quote: "not counts, chars" })).toBe(false);
        expect(isNarrationAnchor({
            kind: "correction", turn_seq: 9, quote: "not counts, chars", outcome: "",
        })).toBe(false);
    });

    test("tool_failure: needs tool, error_excerpt, recovery", () => {
        expect(isNarrationAnchor({
            kind: "tool_failure", turn_seq: 22, tool: "Bash", error_excerpt: "blocked", recovery: "wrapper script",
        })).toBe(true);
        expect(isNarrationAnchor({
            kind: "tool_failure", turn_seq: 22, tool: "Bash", error_excerpt: "blocked",
        })).toBe(false);
    });

    test("term: needs name and definition", () => {
        expect(isNarrationAnchor({ kind: "term", name: "change story", definition: "ordered hunks" })).toBe(true);
        expect(isNarrationAnchor({ kind: "term", name: "change story", definition: "" })).toBe(false);
    });

    test("rejects unknown kinds and non-objects", () => {
        expect(isNarrationAnchor({ kind: "bookmark", turn_seq: 1 })).toBe(false);
        expect(isNarrationAnchor(null)).toBe(false);
        expect(isNarrationAnchor("turn 4")).toBe(false);
    });
});

describe("code_state anchor", () => {
    const valid = {
        kind: "code_state",
        artifact: "review-architecture",
        label: "one fold, one tree",
        lang: "typescript",
        code: "interface FileTouch { path: string }",
    };

    test("accepts a full snapshot", () => {
        expect(isNarrationAnchor(valid)).toBe(true);
    });

    test("accepts an optional turn_seq", () => {
        expect(isNarrationAnchor({ ...valid, turn_seq: 12 })).toBe(true);
    });

    test("rejects empty code or missing artifact", () => {
        expect(isNarrationAnchor({ ...valid, code: "" })).toBe(false);
        expect(isNarrationAnchor({ ...valid, artifact: undefined })).toBe(false);
        expect(isNarrationAnchor({ ...valid, lang: "" })).toBe(false);
    });
});
