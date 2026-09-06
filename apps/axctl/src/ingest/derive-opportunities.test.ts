import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import {
    buildOpportunityRows,
    commandCarriesMarker,
    hookOpportunityAddressed,
    installedArtifactPath,
    isCreditableHookInvocation,
    kebabNameFromArtifactPath,
    opportunityKey,
    overlapFilesMatch,
    parseOverlapFiles,
    parseSkillTriggerTool,
    safeFileMtimeMs,
    triggerTokensFromCandidate,
    type HookInvocationFact,
    type HookOpportunityFact,
} from "./derive-opportunities.ts";

const runMtime = (absPath: string): Promise<number | null> =>
    Effect.runPromise(
        safeFileMtimeMs(absPath).pipe(Effect.provide(BunFileSystem.layer)),
    );

describe("opportunityKey", () => {
    test("deterministic for the same (experiment, evidence) pair", () => {
        const a = opportunityKey("exp_a", "fix_b");
        const b = opportunityKey("exp_a", "fix_b");
        expect(a).toBe(b);
        expect(a).not.toBe(opportunityKey("exp_a", "fix_c"));
    });
});

describe("parseOverlapFiles", () => {
    test("handles JSON array", () => {
        expect(parseOverlapFiles('["schema/schema.surql","src/x.ts"]')).toEqual([
            "schema/schema.surql",
            "src/x.ts",
        ]);
    });

    test("handles null + invalid + non-array", () => {
        expect(parseOverlapFiles(null)).toEqual([]);
        expect(parseOverlapFiles("not-json")).toEqual([]);
        expect(parseOverlapFiles('{"a":1}')).toEqual([]);
    });
});

describe("triggerTokensFromCandidate", () => {
    test("drops short + boilerplate tokens", () => {
        expect(triggerTokensFromCandidate("SurrealDB_schema_change_guardrail")).toEqual([
            "surrealdb",
            "schema",
            "change",
        ]);
        expect(triggerTokensFromCandidate("graph_query_dogfood_checklist")).toEqual([
            "graph",
            "query",
            "dogfood",
        ]);
    });
});

describe("overlapFilesMatch", () => {
    test("matches when any token is a substring of any file path", () => {
        expect(
            overlapFilesMatch(["schema/schema.surql"], ["schema", "change"]),
        ).toBe(true);
        expect(
            overlapFilesMatch(["src/dashboard/web/styles.css"], ["schema"]),
        ).toBe(false);
        expect(overlapFilesMatch([], ["anything"])).toBe(false);
        expect(overlapFilesMatch(["a.ts"], [])).toBe(false);
    });
});

describe("buildOpportunityRows", () => {
    test("emits one row per match with a stable edge id and an ISO matched_at", () => {
        const rows = buildOpportunityRows("exp_1", [
            { evidenceTable: "later_fixed_by", evidenceKey: "edge_a", ts: "2026-05-25T00:00:00.000Z" },
            { evidenceTable: "later_fixed_by", evidenceKey: "edge_b", ts: "2026-05-25T01:00:00.000Z" },
        ]);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({
            id: opportunityKey("exp_1", "edge_a"),
            out_id: "edge_a",
            out_table: "later_fixed_by",
            matched_at: "2026-05-25T00:00:00.000Z",
            was_addressed: false,
        });
    });

    test("carries no in_id - the replacement statement binds the experiment", () => {
        const rows = buildOpportunityRows("exp_1", [
            { evidenceTable: "later_fixed_by", evidenceKey: "edge_a", ts: "2026-05-25T00:00:00.000Z" },
        ]);
        expect(rows[0]).not.toHaveProperty("in_id");
    });

    test("no matches -> no statements", () => {
        expect(buildOpportunityRows("exp_1", [])).toEqual([]);
    });

    test("addressed=true serializes was_addressed = true", () => {
        const rows = buildOpportunityRows("exp_1", [
            { evidenceTable: "later_fixed_by", evidenceKey: "edge_a", ts: "2026-05-25T00:00:00.000Z", addressed: true },
        ]);
        expect(rows[0]!.was_addressed).toBe(true);
    });
});

describe("kebabNameFromArtifactPath (C5a addressed-detector helper)", () => {
    test("extracts the parent-dir kebab name", () => {
        expect(kebabNameFromArtifactPath("/Users/n/.claude/skills/schema-change-guardrail/SKILL.md"))
            .toBe("schema-change-guardrail");
        expect(kebabNameFromArtifactPath("./skills/x/SKILL.md")).toBe("x");
    });

    test("returns null for null/empty/single-segment", () => {
        expect(kebabNameFromArtifactPath(null)).toBeNull();
        expect(kebabNameFromArtifactPath("")).toBeNull();
        expect(kebabNameFromArtifactPath("/SKILL.md")).toBeNull();
    });
});

describe("parseSkillTriggerTool", () => {
    test("extracts the tool name from a tool=<Name> pattern", () => {
        expect(parseSkillTriggerTool("tool=Bash")).toBe("Bash");
        expect(parseSkillTriggerTool("tool=Read")).toBe("Read");
        expect(parseSkillTriggerTool("  tool=Edit  ")).toBe("Edit");
    });

    test("returns null for unrecognised patterns", () => {
        expect(parseSkillTriggerTool("garbage")).toBeNull();
        expect(parseSkillTriggerTool("")).toBeNull();
        expect(parseSkillTriggerTool("cmd=foo")).toBeNull();
    });
});

describe("safeFileMtimeMs", () => {
    test("returns the file mtime in epoch-ms for an existing file", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-mtime-"));
        try {
            const file = join(dir, "CLAUDE.md");
            await writeFile(file, "x");
            const when = new Date("2026-01-02T03:04:05.000Z");
            await utimes(file, when, when);
            expect(await runMtime(file)).toBe(when.getTime());
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("returns null for a directory - a directory mtime is not artifact activity", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-mtime-"));
        try {
            // The guidance path became a directory (a stray `mkdir -p`, a
            // reshaped checkout). Its mtime moves whenever anything lands
            // inside it, which says nothing about the guidance file.
            const asDir = join(dir, "CLAUDE.md");
            await mkdir(asDir);
            expect(await runMtime(asDir)).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("returns null for a missing file (orAbsent)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-mtime-"));
        try {
            expect(await runMtime(join(dir, "does-not-exist.md"))).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// F02 (#1133): observed artifact identity
// ---------------------------------------------------------------------------

const invocation = (over: Partial<HookInvocationFact> = {}): HookInvocationFact => ({
    session: "session-1",
    ts: "2026-05-25T00:00:00.000Z",
    command: "echo 'ax:74da7418' && bun ~/.ax/hooks/enforce-worktree.ts",
    event_name: "PreToolUse",
    tool_call: null,
    tool_call_id: null,
    effect: "blocked",
    provider_status: "blocking_error",
    ...over,
});

const opportunity = (over: Partial<HookOpportunityFact> = {}): HookOpportunityFact => ({
    id: "tool-call-1",
    session: "session-1",
    call_id: null,
    ts: "2026-05-25T00:00:00.000Z",
    ...over,
});

describe("installedArtifactPath", () => {
    test("returns the recorded path", () => {
        expect(installedArtifactPath("/repo/.claude/settings.json")).toBe("/repo/.claude/settings.json");
    });

    test("null for a missing or blank path - never a guessed global file", () => {
        expect(installedArtifactPath(null)).toBeNull();
        expect(installedArtifactPath("")).toBeNull();
        expect(installedArtifactPath("   ")).toBeNull();
        expect(installedArtifactPath("CLAUDE.md")).toBe("CLAUDE.md");
    });
});

describe("commandCarriesMarker", () => {
    test("matches the complete installed marker id in any command shape", () => {
        expect(commandCarriesMarker("echo 'ax:74da7418' && bash guard.sh", "74da7418")).toBe(true);
        expect(commandCarriesMarker("python3 ~/.ax/hooks/guard.py # ax:74da7418", "74da7418")).toBe(true);
        expect(commandCarriesMarker("node ./guard.js --sig ax:74da7418", "74da7418")).toBe(true);
        expect(commandCarriesMarker("bun ~/.ax/hooks/dispatch.ts # ax:74da7418", "74da7418")).toBe(true);
        expect(commandCarriesMarker("ax:74da7418", "74da7418")).toBe(true);
    });

    test("a shared prefix is not the same identity", () => {
        expect(commandCarriesMarker("echo 'ax:74da7418ff' && bash guard.sh", "74da7418")).toBe(false);
        expect(commandCarriesMarker("echo 'ax:74da7418' && bash guard.sh", "74da7418ff")).toBe(false);
        expect(commandCarriesMarker("echo 'ax:74da' && bash guard.sh", "74da7418")).toBe(false);
    });

    test("no marker at all is not a match", () => {
        expect(commandCarriesMarker("bash /Users/x/.claude/hooks/74da7418.sh", "74da7418")).toBe(false);
        expect(commandCarriesMarker("", "74da7418")).toBe(false);
        expect(commandCarriesMarker("echo 'ax:74da7418'", "")).toBe(false);
    });

    test("picks the right one when two markers share a prefix", () => {
        const command = "echo 'ax:74da7418' && echo 'ax:74da7418ff' && bash guard.sh";
        expect(commandCarriesMarker(command, "74da7418")).toBe(true);
        expect(commandCarriesMarker(command, "74da7418ff")).toBe(true);
        expect(commandCarriesMarker(command, "74da74")).toBe(false);
    });
});

describe("isCreditableHookInvocation", () => {
    const identity = { dedupeSig: "74da7418", eventName: "PreToolUse" };

    test("credits a real-effect fire carrying the installed marker", () => {
        expect(isCreditableHookInvocation(invocation(), identity)).toBe(true);
        expect(isCreditableHookInvocation(invocation({ effect: "injected_context", provider_status: "success" }), identity)).toBe(true);
        expect(isCreditableHookInvocation(invocation({ effect: "modified_input", provider_status: "success" }), identity)).toBe(true);
        expect(isCreditableHookInvocation(invocation({ effect: "notified", provider_status: "success" }), identity)).toBe(true);
    });

    test("rejects a different configured event name", () => {
        expect(isCreditableHookInvocation(invocation({ event_name: "PostToolUse" }), identity)).toBe(false);
    });

    test("rejects progress_only, no_op, unknown and allowed records", () => {
        expect(isCreditableHookInvocation(invocation({ provider_status: "progress_only" }), identity)).toBe(false);
        expect(isCreditableHookInvocation(invocation({ effect: "no_op", provider_status: "success" }), identity)).toBe(false);
        expect(isCreditableHookInvocation(invocation({ effect: "unknown", provider_status: "success" }), identity)).toBe(false);
        expect(isCreditableHookInvocation(invocation({ effect: "allowed", provider_status: "success" }), identity)).toBe(false);
    });

    test("rejects a command without the installed marker identity", () => {
        expect(isCreditableHookInvocation(invocation({ command: "bash /Users/x/.claude/hooks/guard.sh" }), identity)).toBe(false);
        expect(isCreditableHookInvocation(invocation({ command: "echo 'ax:74da7418ff' && bash guard.sh" }), identity)).toBe(false);
    });
});

describe("hookOpportunityAddressed", () => {
    test("exact tool_call identity credits only its own call", () => {
        const fires = [invocation({ tool_call: "tool-call-1" })];
        expect(hookOpportunityAddressed(opportunity({ id: "tool-call-1" }), fires)).toBe(true);
        expect(hookOpportunityAddressed(opportunity({ id: "tool-call-2" }), fires)).toBe(false);
    });

    test("exact tool_call_id identity credits only its own call", () => {
        const fires = [invocation({ tool_call_id: "toolu_1" })];
        expect(hookOpportunityAddressed(opportunity({ call_id: "toolu_1" }), fires)).toBe(true);
        expect(hookOpportunityAddressed(opportunity({ call_id: "toolu_2" }), fires)).toBe(false);
    });

    test("does not fall back to the window when the fire carries tool-call identity", () => {
        const fires = [invocation({ tool_call: "tool-call-9" })];
        expect(hookOpportunityAddressed(opportunity({ id: "tool-call-1" }), fires)).toBe(false);
    });

    test("a named fire never credits a call whose own identity is unknown", () => {
        // The fire names `toolu_1`; this call carries no `call_id` at all, so it
        // is not the named call. Falling through to the window here would credit
        // a call the fire demonstrably did not act on.
        const fires = [invocation({ tool_call_id: "toolu_1" })];
        expect(hookOpportunityAddressed(opportunity({ call_id: null }), fires)).toBe(false);
    });

    test("the row reference still wins over the provider id", () => {
        // Both identities present and disagreeing: `tool_call` is the row this
        // fire was recorded against, so it decides.
        const fires = [invocation({ tool_call: "tool-call-1", tool_call_id: "toolu_other" })];
        expect(hookOpportunityAddressed(opportunity({ id: "tool-call-1", call_id: "toolu_1" }), fires)).toBe(true);
        expect(hookOpportunityAddressed(opportunity({ id: "tool-call-2", call_id: "toolu_other" }), fires)).toBe(false);
    });

    test("falls back to the time window inside the same session when neither record has identity", () => {
        const fires = [invocation({ ts: "2026-05-25T00:30:00.000Z" })];
        expect(hookOpportunityAddressed(opportunity(), fires)).toBe(true);
        expect(hookOpportunityAddressed(opportunity({ ts: "2026-05-25T04:00:00.000Z" }), fires)).toBe(false);
    });

    test("never credits across sessions", () => {
        const fires = [invocation({ session: "session-2", tool_call: "tool-call-1" })];
        expect(hookOpportunityAddressed(opportunity({ id: "tool-call-1" }), fires)).toBe(false);
        expect(hookOpportunityAddressed(opportunity(), [invocation({ session: "session-2" })])).toBe(false);
        expect(hookOpportunityAddressed(opportunity({ session: null }), [invocation({ session: null })])).toBe(false);
    });

    test("no fires at all is not addressed", () => {
        expect(hookOpportunityAddressed(opportunity(), [])).toBe(false);
    });
});
