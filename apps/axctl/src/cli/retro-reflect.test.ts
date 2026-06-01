import { describe, expect, test } from "bun:test";
import {
    buildRetroReflectQuery,
    renderReflectDetail,
    renderReflectTable,
    type RetroReflectRow,
} from "./retro-reflect.ts";

const sampleRow = (overrides: Partial<RetroReflectRow> = {}): RetroReflectRow => ({
    proposalKey: "skill__retro__bash__abcdef123456",
    dedupeSig: "skill__pre_bash_guard",
    title: "Pre-Bash guard",
    hypothesis: "Bash failed 7 times across 3 sessions.",
    frequency: 7,
    confidence: "medium",
    triggerPattern: "tool=Bash",
    suspectedGap: "no pre-call validation",
    proposedBehavior: "validate Bash preconditions before invocation",
    retroKeys: ["r1", "r2", "r3"],
    sessionKeys: ["s1", "s2", "s3"],
    ...overrides,
});

describe("renderReflectTable", () => {
    test("includes column headers FREQ, CONF, SESSIONS, TITLE", () => {
        const out = renderReflectTable([sampleRow()]);
        expect(out).toContain("FREQ");
        expect(out).toContain("CONF");
        expect(out).toContain("SESSIONS");
        expect(out).toContain("TITLE");
    });

    test("preserves the input order of rows", () => {
        const rows = [
            sampleRow({ title: "Alpha", frequency: 9 }),
            sampleRow({ title: "Beta", frequency: 5 }),
            sampleRow({ title: "Gamma", frequency: 3 }),
        ];
        const out = renderReflectTable(rows);
        const idxA = out.indexOf("Alpha");
        const idxB = out.indexOf("Beta");
        const idxG = out.indexOf("Gamma");
        expect(idxA).toBeLessThan(idxB);
        expect(idxB).toBeLessThan(idxG);
    });

    test("handles empty input without throwing", () => {
        const out = renderReflectTable([]);
        expect(out).toContain("(none)");
    });

    test("truncates very long titles with ellipsis", () => {
        const long = "X".repeat(120);
        const out = renderReflectTable([sampleRow({ title: long })]);
        expect(out).toContain("…");
    });
});

describe("renderReflectDetail", () => {
    test("mentions trigger, behavior, and the retro count", () => {
        const out = renderReflectDetail(sampleRow());
        expect(out).toContain("tool=Bash");
        expect(out).toContain("validate Bash preconditions before invocation");
        expect(out).toContain("3 retro(s)");
    });

    test("includes hypothesis + confidence + frequency", () => {
        const out = renderReflectDetail(sampleRow());
        expect(out).toContain("Bash failed 7 times across 3 sessions.");
        expect(out).toContain("freq=7");
        expect(out).toContain("conf=medium");
    });
});

describe("buildRetroReflectQuery", () => {
    test("filters on the retro proposal-key marker prefix", () => {
        const sql = buildRetroReflectQuery({ sinceDays: 30, status: "open" });
        expect(sql).toContain("skill__retro__");
        expect(sql).toMatch(/string::contains\(<string>id/);
    });

    test("includes a sub-SELECT against skill_proposal", () => {
        const sql = buildRetroReflectQuery({ sinceDays: 30, status: "open" });
        expect(sql).toMatch(/SELECT[\s\S]+FROM skill_proposal/);
        expect(sql).toContain("proposal = $parent.id");
    });

    test("filters by status='open' by default but allows --status=all", () => {
        const open = buildRetroReflectQuery({ sinceDays: 30, status: "open" });
        expect(open).toContain("status = 'open'");
        const all = buildRetroReflectQuery({ sinceDays: 30, status: "all" });
        expect(all).not.toContain("status =");
    });

    test("orders by frequency DESC", () => {
        const sql = buildRetroReflectQuery({ sinceDays: 30, status: "open" });
        expect(sql).toMatch(/ORDER BY\s+frequency\s+DESC/);
    });

    test("respects sinceDays in the WHERE clause", () => {
        const sql = buildRetroReflectQuery({ sinceDays: 7, status: "open" });
        expect(sql).toContain("time::now() - 7d");
    });
});
