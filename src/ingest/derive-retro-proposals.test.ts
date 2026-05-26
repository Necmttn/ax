import { describe, expect, test } from "bun:test";
import {
    buildRetroSkillProposalStatements,
    clusterRetroToolFailures,
    deriveRetroProposalRows,
    parseRetroFailed,
    type RetroFailureRow,
    type RetroSkillProposalRow,
} from "./derive-retro-proposals.ts";

describe("parseRetroFailed", () => {
    test("returns [] for null", () => {
        expect(parseRetroFailed(null)).toEqual([]);
    });

    test("parses a single tool failure", () => {
        expect(parseRetroFailed("Bash failed ×3")).toEqual([
            { tool: "Bash", count: 3 },
        ]);
    });

    test("parses a failure mention embedded with friction kinds", () => {
        expect(parseRetroFailed("Bash failed ×3 · friction kinds: tool_error")).toEqual([
            { tool: "Bash", count: 3 },
        ]);
    });

    test("parses multiple failures in one string", () => {
        expect(parseRetroFailed("Bash failed ×3 · Read failed ×2")).toEqual([
            { tool: "Bash", count: 3 },
            { tool: "Read", count: 2 },
        ]);
    });

    test("ignores strings without the pattern", () => {
        expect(parseRetroFailed("3 user correction(s)")).toEqual([]);
        expect(parseRetroFailed("friction kinds: tool_error")).toEqual([]);
    });
});

describe("clusterRetroToolFailures", () => {
    const opts = { minSessions: 2, minRetros: 2, minTotalCount: 3 };

    test("groups two retros from two sessions into one cluster", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "Bash failed ×2" },
            { retroKey: "r2", sessionKey: "s2", failed: "Bash failed ×3" },
        ];
        const clusters = clusterRetroToolFailures(rows, opts);
        expect(clusters).toHaveLength(1);
        const c = clusters[0]!;
        expect(c.tool).toBe("Bash");
        expect(c.toolLower).toBe("bash");
        expect(c.totalCount).toBe(5);
        expect(new Set(c.retroKeys)).toEqual(new Set(["r1", "r2"]));
        expect(new Set(c.sessionKeys)).toEqual(new Set(["s1", "s2"]));
    });

    test("skips a cluster that only spans one session", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "Bash failed ×3" },
            { retroKey: "r2", sessionKey: "s1", failed: "Bash failed ×3" },
        ];
        expect(clusterRetroToolFailures(rows, opts)).toEqual([]);
    });

    test("skips a cluster below minTotalCount", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "Bash failed ×1" },
            { retroKey: "r2", sessionKey: "s2", failed: "Bash failed ×1" },
        ];
        expect(clusterRetroToolFailures(rows, opts)).toEqual([]);
    });

    test("sorts descending by totalCount", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "Read failed ×2" },
            { retroKey: "r2", sessionKey: "s2", failed: "Read failed ×2" },
            { retroKey: "r3", sessionKey: "s3", failed: "Bash failed ×5" },
            { retroKey: "r4", sessionKey: "s4", failed: "Bash failed ×5" },
        ];
        const clusters = clusterRetroToolFailures(rows, opts);
        expect(clusters.map((c) => c.tool)).toEqual(["Bash", "Read"]);
    });

    test("dedupes retroKey and sessionKey within a cluster", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "Bash failed ×2 · Bash failed ×1" },
            { retroKey: "r2", sessionKey: "s2", failed: "Bash failed ×2" },
        ];
        const clusters = clusterRetroToolFailures(rows, opts);
        expect(clusters).toHaveLength(1);
        const c = clusters[0]!;
        expect(c.retroKeys).toHaveLength(2);
        expect(c.sessionKeys).toHaveLength(2);
        expect(c.totalCount).toBe(5);
    });

    test("lowercases tool key but preserves first-seen casing in .tool", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "Bash failed ×2" },
            { retroKey: "r2", sessionKey: "s2", failed: "bash failed ×2" },
        ];
        const clusters = clusterRetroToolFailures(rows, opts);
        expect(clusters).toHaveLength(1);
        const c = clusters[0]!;
        expect(c.tool).toBe("Bash");
        expect(c.toolLower).toBe("bash");
        expect(c.totalCount).toBe(4);
    });
});

describe("deriveRetroProposalRows", () => {
    const cluster = {
        tool: "Bash",
        toolLower: "bash",
        totalCount: 7,
        retroKeys: ["r1", "r2"],
        sessionKeys: ["s1", "s2"],
    } as const;

    test("emits a row with frequency=totalCount and skill__-prefixed sig", () => {
        const { rows, skipped } = deriveRetroProposalRows([cluster], new Set());
        expect(skipped).toBe(0);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.title).toBe("Pre-Bash guard");
        expect(row.frequency).toBe(7);
        expect(row.sig.startsWith("skill__")).toBe(true);
        expect(row.confidence).toBe("medium");
        expect(row.tool).toBe("Bash");
    });

    test("skips when an existing skill already covers the normalized title", () => {
        const { rows, skipped } = deriveRetroProposalRows(
            [cluster],
            new Set(["pre-bash guard"]),
        );
        expect(rows).toEqual([]);
        expect(skipped).toBe(1);
    });

    test("confidence boundaries: <5 low, 5-9 medium, >=10 high", () => {
        const mk = (count: number) => ({
            tool: "T",
            toolLower: "t",
            totalCount: count,
            retroKeys: ["r1"],
            sessionKeys: ["s1"],
        });
        expect(deriveRetroProposalRows([mk(4)], new Set()).rows[0]!.confidence).toBe("low");
        expect(deriveRetroProposalRows([mk(5)], new Set()).rows[0]!.confidence).toBe("medium");
        expect(deriveRetroProposalRows([mk(9)], new Set()).rows[0]!.confidence).toBe("medium");
        expect(deriveRetroProposalRows([mk(10)], new Set()).rows[0]!.confidence).toBe("high");
    });
});

describe("buildRetroSkillProposalStatements", () => {
    const baseRow: RetroSkillProposalRow = {
        proposalKey: "skill__retro__Bash__abcdef123456",
        title: "Pre-Bash guard",
        hypothesis: "Bash failed 7 time(s) across 2 sessions; guard the call before invoking.",
        triggerPattern: "tool=Bash",
        suspectedGap: "repeated Bash failures without a pre-call validation",
        proposedBehavior: "validate Bash preconditions before invocation; on miss, surface a corrective message",
        expectedImpact: "reduce Bash failure rate",
        confidence: "medium",
        frequency: 7,
        sig: "skill__abcdef123456",
        tool: "Bash",
        retroKeys: ["r1", "r2"],
        sessionKeys: ["s1", "s2"],
    };

    test("new sig: CREATE proposal with form=skill, status=open, baseline, and UPSERT skill_proposal", () => {
        const sql = buildRetroSkillProposalStatements([baseRow], new Set()).join("\n");
        expect(sql).toContain("CREATE proposal:");
        expect(sql).toContain('form: "skill"');
        expect(sql).toContain('status: "open"');
        expect(sql).toContain("baseline:");
        expect(sql).toContain("UPSERT skill_proposal:");
    });

    test("existing sig: UPDATE only, no CREATE, no status=, no baseline=, but frequency = N", () => {
        const sql = buildRetroSkillProposalStatements([baseRow], new Set([baseRow.sig])).join("\n");
        expect(sql).toContain("UPDATE proposal:");
        expect(sql).not.toContain("CREATE proposal:");
        expect(sql).not.toMatch(/\bstatus\s*=/);
        expect(sql).not.toMatch(/\bbaseline\s*=/);
        expect(sql).toMatch(/\bfrequency\s*=\s*7/);
        expect(sql).toContain("UPSERT skill_proposal:");
    });

    test("baseline JSON encodes tool name and retroKeys list", () => {
        const sql = buildRetroSkillProposalStatements([baseRow], new Set()).join("\n");
        // The baseline is wrapped in a SurrealQL string literal (JSON-stringified
        // once), so the inner quotes are backslash-escaped in the emitted SQL.
        expect(sql).toContain('\\"tool\\":\\"Bash\\"');
        expect(sql).toContain('\\"retroKeys\\":[\\"r1\\",\\"r2\\"]');
    });
});
