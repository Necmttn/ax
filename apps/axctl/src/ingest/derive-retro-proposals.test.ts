import { describe, expect, test } from "bun:test";
import {
    buildRetroCorrectionGuidanceStatements,
    buildRetroFrictionSkillStatements,
    buildRetroSkillProposalStatements,
    clusterRetroCorrections,
    clusterRetroFrictionKinds,
    clusterRetroToolFailures,
    deriveRetroCorrectionProposalRows,
    deriveRetroFrictionSkillRows,
    deriveRetroProposalRows,
    parseRetroCorrections,
    parseRetroFailed,
    parseRetroFrictionKinds,
    type RetroFailureRow,
    type RetroFrictionCluster,
    type RetroGuidanceProposalRow,
    type RetroFrictionSkillProposalRow,
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

describe("parseRetroCorrections", () => {
    test("returns 0 for null", () => {
        expect(parseRetroCorrections(null)).toBe(0);
    });

    test("parses plural form", () => {
        expect(parseRetroCorrections("5 user correction(s)")).toBe(5);
    });

    test("parses singular form", () => {
        expect(parseRetroCorrections("1 user correction")).toBe(1);
    });

    test("returns 0 when pattern absent", () => {
        expect(parseRetroCorrections("Bash failed ×3")).toBe(0);
    });

    test("picks the first user-correction count when embedded", () => {
        expect(
            parseRetroCorrections(
                "Bash failed ×3 · 5 user correction(s) · friction kinds: tool_error",
            ),
        ).toBe(5);
    });
});

describe("parseRetroFrictionKinds", () => {
    test("returns [] for null", () => {
        expect(parseRetroFrictionKinds(null)).toEqual([]);
    });

    test("returns [] when pattern absent", () => {
        expect(parseRetroFrictionKinds("Bash failed ×3")).toEqual([]);
    });

    test("parses a comma-separated list", () => {
        expect(
            parseRetroFrictionKinds(
                "friction kinds: tool_error, user_correction, command_failed",
            ),
        ).toEqual(["tool_error", "user_correction", "command_failed"]);
    });

    test("stops at the next · separator", () => {
        expect(
            parseRetroFrictionKinds(
                "friction kinds: tool_error, user_correction · 3 user correction(s)",
            ),
        ).toEqual(["tool_error", "user_correction"]);
    });

    test("trims whitespace and lowercases tokens", () => {
        expect(
            parseRetroFrictionKinds("friction kinds:   Tool_Error ,  user_correction "),
        ).toEqual(["tool_error", "user_correction"]);
    });
});

describe("clusterRetroCorrections", () => {
    const opts = { minSessions: 2, minTotalCorrections: 3 };

    test("returns null below session threshold", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "5 user correction(s)", corrections: 5, frictionKinds: [] },
        ];
        expect(clusterRetroCorrections(rows, opts)).toBeNull();
    });

    test("returns null below correction total threshold", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "1 user correction(s)", corrections: 1, frictionKinds: [] },
            { retroKey: "r2", sessionKey: "s2", failed: "1 user correction(s)", corrections: 1, frictionKinds: [] },
        ];
        expect(clusterRetroCorrections(rows, opts)).toBeNull();
    });

    test("aggregates across sessions when thresholds met", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "2 user correction(s)", corrections: 2, frictionKinds: [] },
            { retroKey: "r2", sessionKey: "s2", failed: "3 user correction(s)", corrections: 3, frictionKinds: [] },
        ];
        const cluster = clusterRetroCorrections(rows, opts);
        expect(cluster).not.toBeNull();
        expect(cluster!.totalCorrections).toBe(5);
        expect(new Set(cluster!.retroKeys)).toEqual(new Set(["r1", "r2"]));
        expect(new Set(cluster!.sessionKeys)).toEqual(new Set(["s1", "s2"]));
    });

    test("falls back to parsing failed when corrections is missing", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "2 user correction(s)" },
            { retroKey: "r2", sessionKey: "s2", failed: "3 user correction(s)" },
        ];
        const cluster = clusterRetroCorrections(rows, opts);
        expect(cluster?.totalCorrections).toBe(5);
    });
});

describe("clusterRetroFrictionKinds", () => {
    const opts = { minSessions: 2, minRetros: 2 };

    test("emits one cluster per kind, sorted by descending totalCount", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "", frictionKinds: ["tool_error", "user_correction"] },
            { retroKey: "r2", sessionKey: "s2", failed: "", frictionKinds: ["tool_error", "user_correction"] },
            { retroKey: "r3", sessionKey: "s3", failed: "", frictionKinds: ["tool_error"] },
        ];
        const clusters = clusterRetroFrictionKinds(rows, opts);
        expect(clusters.map((c) => c.kind)).toEqual(["tool_error", "user_correction"]);
        expect(clusters[0]!.totalCount).toBe(3);
        expect(clusters[1]!.totalCount).toBe(2);
    });

    test("drops kinds below thresholds", () => {
        const rows: RetroFailureRow[] = [
            { retroKey: "r1", sessionKey: "s1", failed: "", frictionKinds: ["only_once"] },
            { retroKey: "r2", sessionKey: "s2", failed: "", frictionKinds: ["tool_error"] },
            { retroKey: "r3", sessionKey: "s3", failed: "", frictionKinds: ["tool_error"] },
        ];
        const clusters = clusterRetroFrictionKinds(rows, opts);
        expect(clusters.map((c) => c.kind)).toEqual(["tool_error"]);
    });
});

describe("deriveRetroCorrectionProposalRows", () => {
    test("returns empty rows when cluster is null", () => {
        expect(deriveRetroCorrectionProposalRows(null)).toEqual({ rows: [], skipped: 0 });
    });

    test("emits a guidance-prefixed sig targeting CLAUDE.md", () => {
        const { rows } = deriveRetroCorrectionProposalRows({
            totalCorrections: 7,
            retroKeys: ["r1", "r2"],
            sessionKeys: ["s1", "s2"],
        });
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.sig.startsWith("guidance__")).toBe(true);
        expect(row.fileTarget).toBe("CLAUDE.md");
        expect(row.frequency).toBe(7);
        expect(row.confidence).toBe("medium");
    });
});

describe("deriveRetroFrictionSkillRows", () => {
    const clusters: RetroFrictionCluster[] = [
        { kind: "tool_error", totalCount: 4, retroKeys: ["r1", "r2"], sessionKeys: ["s1", "s2"] },
        { kind: "user_correction", totalCount: 3, retroKeys: ["r3", "r4"], sessionKeys: ["s3", "s4"] },
    ];

    test("emits one row per kind with skill__-prefixed sigs", () => {
        const { rows, skipped } = deriveRetroFrictionSkillRows(clusters, new Set());
        expect(skipped).toBe(0);
        expect(rows).toHaveLength(2);
        expect(rows[0]!.sig.startsWith("skill__")).toBe(true);
        expect(rows[0]!.kind).toBe("tool_error");
        expect(rows[1]!.kind).toBe("user_correction");
    });

    test("skips kinds whose normalized title collides with an existing skill", () => {
        const { rows, skipped } = deriveRetroFrictionSkillRows(
            clusters,
            new Set(["address recurring tool_error friction"]),
        );
        expect(skipped).toBe(1);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.kind).toBe("user_correction");
    });
});

describe("buildRetroCorrectionGuidanceStatements", () => {
    const row: RetroGuidanceProposalRow = {
        proposalKey: "guidance__retro_corrections__abcdef123456",
        title: "Reduce recurring user corrections",
        hypothesis: "7 corrections across 2 sessions; gap in CLAUDE.md likely.",
        fileTarget: "CLAUDE.md",
        section: "Corrections",
        suggestedText: "Address recurring user corrections (7 across 2 sessions).",
        confidence: "medium",
        frequency: 7,
        sig: "guidance__abcdef123456",
        retroKeys: ["r1", "r2"],
        sessionKeys: ["s1", "s2"],
    };

    test("new sig: CREATE proposal form=guidance, UPSERT guidance_proposal", () => {
        const sql = buildRetroCorrectionGuidanceStatements([row], new Set()).join("\n");
        expect(sql).toContain("CREATE proposal:");
        expect(sql).toContain('form: "guidance"');
        expect(sql).toContain('status: "open"');
        expect(sql).toContain("UPSERT guidance_proposal:");
    });

    test("baseline JSON encodes kind=corrections", () => {
        const sql = buildRetroCorrectionGuidanceStatements([row], new Set()).join("\n");
        expect(sql).toContain('\\"kind\\":\\"corrections\\"');
    });

    test("existing sig: UPDATE only, no CREATE, no baseline=", () => {
        const sql = buildRetroCorrectionGuidanceStatements([row], new Set([row.sig])).join("\n");
        expect(sql).toContain("UPDATE proposal:");
        expect(sql).not.toContain("CREATE proposal:");
        expect(sql).not.toMatch(/\bbaseline\s*=/);
        expect(sql).toContain("UPSERT guidance_proposal:");
    });
});

describe("buildRetroFrictionSkillStatements", () => {
    const row: RetroFrictionSkillProposalRow = {
        proposalKey: "skill__retro_friction__tool_error__abcdef123456",
        title: "Address recurring tool_error friction",
        hypothesis: "tool_error friction appeared in 2 sessions",
        triggerPattern: "friction_kind=tool_error",
        suspectedGap: "recurring tool_error signals across sessions without a guard",
        proposedBehavior: "detect tool_error pre-conditions and intervene",
        expectedImpact: "reduce tool_error occurrence rate",
        confidence: "low",
        frequency: 4,
        sig: "skill__abcdef123456",
        kind: "tool_error",
        retroKeys: ["r1", "r2"],
        sessionKeys: ["s1", "s2"],
    };

    test("new sig: CREATE proposal form=skill, UPSERT skill_proposal, baseline has kind", () => {
        const sql = buildRetroFrictionSkillStatements([row], new Set()).join("\n");
        expect(sql).toContain("CREATE proposal:");
        expect(sql).toContain('form: "skill"');
        expect(sql).toContain("UPSERT skill_proposal:");
        expect(sql).toContain('\\"kind\\":\\"tool_error\\"');
    });

    test("existing sig: UPDATE only, no CREATE, payload still UPSERTs", () => {
        const sql = buildRetroFrictionSkillStatements([row], new Set([row.sig])).join("\n");
        expect(sql).toContain("UPDATE proposal:");
        expect(sql).not.toContain("CREATE proposal:");
        expect(sql).toContain("UPSERT skill_proposal:");
    });
});
