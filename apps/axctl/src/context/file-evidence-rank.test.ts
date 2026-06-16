import { describe, expect, test } from "bun:test";
import type { SessionTurn, ToolEvidenceRow } from "./file-evidence.ts";
import {
    clip,
    compactToolEvidence,
    durationMs,
    extractFileContextSignals,
    numeric,
    rankSessionTurn,
    rankSessionTurns,
    rankToolEvidence,
} from "./file-evidence-rank.ts";

describe("extractFileContextSignals", () => {
    test("combines prompt paths, file hints, errors, and symbols", () => {
        const signals = extractFileContextSignals(
            'Bug: "turn.intent_kind is missing" in classifyTurnIntent after src/ingest/codex.ts reingest',
            ["schema/schema.surql"],
        );

        expect(signals.paths).toEqual(["src/ingest/codex.ts", "schema/schema.surql"]);
        expect(signals.errors).toContain("turn.intent_kind is missing");
        expect(signals.symbols).toContain("intent_kind");
        expect(signals.symbols).toContain("classifyTurnIntent");
    });

    test("dedupes paths and ignores short/stop-word tokens", () => {
        const signals = extractFileContextSignals("fix the bug after that in foo.ts and foo.ts", ["foo.ts"]);
        expect(signals.paths).toEqual(["foo.ts"]);
        // "bug", "after", "that" are stop words / too short to be symbols.
        expect(signals.symbols).not.toContain("bug");
    });
});

describe("numeric / durationMs / clip", () => {
    test("numeric coerces finite non-negative, else 0", () => {
        expect(numeric(5)).toBe(5);
        expect(numeric(-3)).toBe(0);
        expect(numeric(null)).toBe(0);
        expect(numeric(undefined)).toBe(0);
        expect(numeric(Number.NaN)).toBe(0);
    });

    test("durationMs returns positive span or null on bad/inverted input", () => {
        expect(durationMs("2026-05-10T00:00:00.000Z", "2026-05-10T00:00:01.000Z")).toBe(1000);
        expect(durationMs(null, "2026-05-10T00:00:01.000Z")).toBeNull();
        expect(durationMs("2026-05-10T00:00:02.000Z", "2026-05-10T00:00:01.000Z")).toBeNull();
        expect(durationMs("not-a-date", "2026-05-10T00:00:01.000Z")).toBeNull();
    });

    test("clip truncates with ellipsis only past the limit", () => {
        expect(clip("short", 10)).toBe("short");
        expect(clip("abcdef", 4)).toBe("abc...");
    });
});

describe("rankToolEvidence", () => {
    const base: ToolEvidenceRow = { kind: "read_file" };
    test("searched_file outranks read_file; rg and Read add weight", () => {
        expect(rankToolEvidence({ ...base, kind: "searched_file" })).toBeGreaterThan(rankToolEvidence(base));
        expect(rankToolEvidence({ ...base, command_norm: "rg" })).toBe(rankToolEvidence(base) + 3);
        expect(rankToolEvidence({ ...base, tool_name: "Read" })).toBe(rankToolEvidence(base) + 2);
    });
    test("correction/preference intent adds weight", () => {
        expect(rankToolEvidence({ ...base, turn: { intent_kind: "correction" } })).toBe(rankToolEvidence(base) + 2);
    });
});

describe("rankSessionTurn(s)", () => {
    const turn = (over: Partial<SessionTurn>): SessionTurn => ({ id: "t", session: "s", ...over });
    test("corrections beat organic, token hits accumulate", () => {
        const tokens = ["intent", "codex"];
        const correction = turn({ intent_kind: "correction", text_excerpt: "fix the intent in codex parser" });
        const organic = turn({ intent_kind: "organic_task", text_excerpt: "unrelated work here" });
        expect(rankSessionTurn(correction, tokens)).toBeGreaterThan(rankSessionTurn(organic, tokens));
    });
    test("drops empty excerpts and sorts by score", () => {
        const tokens = ["intent"];
        const ranked = rankSessionTurns(
            [
                turn({ id: "empty", text_excerpt: "  " }),
                turn({ id: "low", intent_kind: "organic_task", text_excerpt: "no match here" }),
                turn({ id: "high", intent_kind: "correction", text_excerpt: "intent bug" }),
            ],
            tokens,
        );
        expect(ranked.map((t) => t.id)).toEqual(["high", "low"]);
    });
});

describe("compactToolEvidence", () => {
    test("dedupes by kind+path+tool+command, keeping the higher-ranked row", () => {
        const rows: ToolEvidenceRow[] = [
            // Same dedup key (kind+path+tool+command) - the correction-intent row
            // outranks the plain one and wins.
            { kind: "searched_file", path: "a.ts", command_norm: "rg", ts: "2026-05-10T00:00:00.000Z" },
            { kind: "searched_file", path: "a.ts", command_norm: "rg", ts: "2026-05-10T00:00:01.000Z", turn: { intent_kind: "correction" } },
            { kind: "read_file", path: "b.ts", ts: "2026-05-10T00:00:00.000Z" },
        ];
        const out = compactToolEvidence(rows);
        const aRows = out.filter((r) => r.path === "a.ts");
        expect(aRows).toHaveLength(1);
        expect(aRows[0]?.turn?.intent_kind).toBe("correction");
        expect(out).toHaveLength(2);
    });
});
