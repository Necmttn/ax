/**
 * Tests for `cmdSkillsLint` (P3.5).
 *
 * All tests run through Effect.runPromise with a mock SurrealClientShape so
 * no real DB connection is needed.
 */
import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import { cmdSkillsLint, type LintReport } from "./skills-lint.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// Briefs have YAML frontmatter at the very top (--- block), matching the
// classify brief spec. The rendering template wraps the YAML in a fenced
// code block for readability, but filled briefs have the frontmatter at top.
// ---------------------------------------------------------------------------

const FILLED_BRIEF = `---
ax_classify: worktree-read-strategy
primary_role: framing
secondary: [execution, repair]
confidence: 0.8
rationale: |
  This skill frames the approach before reading.
---

# ax classify: worktree-read-strategy
`;

const PENDING_BRIEF = `---
ax_classify: some-skill
primary_role:
secondary: []
confidence: 1.0
---

# ax classify: some-skill
`;

const MALFORMED_BRIEF_NO_AX_CLASSIFY = `---
primary_role: framing
secondary: []
---

# ax classify: missing-field
`;

const UNKNOWN_SKILL_BRIEF = `---
ax_classify: ghost-skill-xyz
primary_role: execution
secondary: []
---

# ax classify: ghost-skill-xyz
`;

// A brief with both primary and secondary containing duplicate after normalise
const DEDUP_BRIEF = `---
ax_classify: worktree-read-strategy
primary_role: Framing
secondary: [FRAMING, execution]
---

# ax classify: worktree-read-strategy
`;

// A brief with no frontmatter at all
const NO_FRONTMATTER_BRIEF = `# ax classify: no-yaml

Just markdown, no frontmatter here.
`;

// ---------------------------------------------------------------------------
// Mock SurrealClient factory
// ---------------------------------------------------------------------------

type QueryCall = { sql: string; bindings?: unknown };

interface MockDbState {
    readonly queries: QueryCall[];
    readonly upserts: Array<{ id: unknown; data: unknown }>;
    /** skill name -> record key (id part) */
    readonly knownSkills: Map<string, string>;
}

function makeMockDb(knownSkills: Map<string, string>): {
    db: SurrealClientShape;
    state: MockDbState;
} {
    const state: MockDbState = {
        queries: [],
        upserts: [],
        knownSkills,
    };

    const db: SurrealClientShape = {
        query: (sql: string, bindings?: unknown) => {
            state.queries.push({ sql, bindings });
            // Skill lookup: SELECT id FROM skill WHERE name = $name LIMIT 1;
            if (
                typeof sql === "string" &&
                sql.includes("SELECT id FROM skill WHERE name") &&
                typeof bindings === "object" &&
                bindings !== null &&
                "name" in bindings
            ) {
                const name = String((bindings as Record<string, unknown>)["name"]);
                const key = knownSkills.get(name);
                if (key === undefined) {
                    return Effect.succeed([[]] as unknown as never);
                }
                return Effect.succeed([[{ id: `skill:${key}` }]] as unknown as never);
            }
            // All other queries (DELETE, RELATE) succeed silently
            return Effect.succeed([] as unknown as never);
        },
        upsert: (id: unknown, data: unknown) => {
            state.upserts.push({ id, data });
            return Effect.void as Effect.Effect<never>;
        },
    } as unknown as SurrealClientShape;

    return { db, state };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTaskDir(prefix: string): Promise<string> {
    const dir = join(tmpdir(), `ax-skills-lint-test-${prefix}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    return dir;
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function runLint(
    db: SurrealClientShape,
    opts: { taskDir: string; dryRun?: boolean; json?: boolean },
): Promise<void> {
    return Effect.runPromise(
        cmdSkillsLint({
            taskDir: opts.taskDir,
            dryRun: opts.dryRun ?? false,
            json: opts.json ?? false,
        }).pipe(Effect.provideService(SurrealClient, db)),
    );
}

/** Capture console.log output during the effect run, returning the report for JSON mode. */
async function runLintJson(
    db: SurrealClientShape,
    opts: { taskDir: string; dryRun?: boolean },
): Promise<LintReport> {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
    };
    try {
        await runLint(db, { ...opts, json: true });
    } finally {
        console.log = origLog;
    }
    return JSON.parse(lines.join("\n")) as LintReport;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cmdSkillsLint", () => {
    // 1. Filled brief → 2+ edges written, file removed
    it("applies filled brief: writes primary+secondary edges and removes file", async () => {
        const taskDir = await createTaskDir("filled");
        const filePath = join(taskDir, "classify-worktree-read-strategy.md");
        await writeFile(filePath, FILLED_BRIEF, "utf8");

        const knownSkills = new Map([["worktree-read-strategy", "worktree-read-strategy"]]);
        const { db, state } = makeMockDb(knownSkills);

        const report = await runLintJson(db, { taskDir });

        // Edges: primary=framing + secondary=[execution, repair] = 3
        expect(report.applied).toBe(1);
        expect(report.pending).toBe(0);
        expect(report.errors).toBe(0);

        const briefResult = report.briefs[0]!;
        expect(briefResult.action).toBe("applied");
        expect(briefResult.skill).toBe("worktree-read-strategy");
        expect(briefResult.edgesWritten).toBe(3);

        // File must be removed after successful apply
        expect(await fileExists(filePath)).toBe(false);

        // State: 1 DELETE sweep, 3 upserts (role nodes), 3 RELATE queries
        const relateQueries = state.queries.filter((q) => q.sql.includes("RELATE"));
        expect(relateQueries.length).toBe(3);

        // All RELATE queries use literal record ids, not bindings
        for (const q of relateQueries) {
            expect(q.sql).toMatch(/skill:`[^`]+`->plays_role->role:`[^`]+`/);
            expect(q.sql).toContain('source = "brief"');
            // Bindings should not carry the record ids
            expect(q.bindings).toBeUndefined();
        }

        // Upserted role nodes: framing, execution, repair
        const roleNames = state.upserts.map((u) => (u.data as Record<string, unknown>)["name"]);
        expect(roleNames).toContain("framing");
        expect(roleNames).toContain("execution");
        expect(roleNames).toContain("repair");
    });

    // 2. Pending brief (no primary_role) → no DB writes, file remains
    it("skips pending brief (empty primary_role): no writes, file stays", async () => {
        const taskDir = await createTaskDir("pending");
        const filePath = join(taskDir, "classify-some-skill.md");
        await writeFile(filePath, PENDING_BRIEF, "utf8");

        const knownSkills = new Map([["some-skill", "some-skill"]]);
        const { db, state } = makeMockDb(knownSkills);

        const report = await runLintJson(db, { taskDir });

        expect(report.pending).toBe(1);
        expect(report.applied).toBe(0);
        expect(report.errors).toBe(0);

        // File must remain
        expect(await fileExists(filePath)).toBe(true);

        // No DB operations at all
        expect(state.queries.filter((q) => q.sql.includes("RELATE")).length).toBe(0);
        expect(state.upserts.length).toBe(0);
    });

    // 3. Malformed brief (no ax_classify) → error reported, file remains
    it("reports error for brief missing ax_classify, file stays", async () => {
        const taskDir = await createTaskDir("malformed");
        const filePath = join(taskDir, "classify-missing-field.md");
        await writeFile(filePath, MALFORMED_BRIEF_NO_AX_CLASSIFY, "utf8");

        const { db, state } = makeMockDb(new Map());

        const report = await runLintJson(db, { taskDir });

        expect(report.errors).toBe(1);
        expect(report.applied).toBe(0);
        const r = report.briefs[0]!;
        expect(r.action).toBe("error");
        expect(r.error).toMatch(/ax_classify/);

        expect(await fileExists(filePath)).toBe(true);
        expect(state.queries.filter((q) => q.sql.includes("RELATE")).length).toBe(0);
    });

    // 3b. No frontmatter at all
    it("reports error for brief with no YAML frontmatter, file stays", async () => {
        const taskDir = await createTaskDir("nofm");
        const filePath = join(taskDir, "classify-no-yaml.md");
        await writeFile(filePath, NO_FRONTMATTER_BRIEF, "utf8");

        const { db } = makeMockDb(new Map());
        const report = await runLintJson(db, { taskDir });

        expect(report.errors).toBe(1);
        expect(await fileExists(filePath)).toBe(true);
    });

    // 4. Unknown skill → error reported, file remains, NO partial role writes
    it("reports error for unknown skill, no partial role writes, file stays", async () => {
        const taskDir = await createTaskDir("unknown-skill");
        const filePath = join(taskDir, "classify-ghost-skill-xyz.md");
        await writeFile(filePath, UNKNOWN_SKILL_BRIEF, "utf8");

        // Empty map = no known skills
        const { db, state } = makeMockDb(new Map());

        const report = await runLintJson(db, { taskDir });

        expect(report.errors).toBe(1);
        expect(report.applied).toBe(0);
        const r = report.briefs[0]!;
        expect(r.action).toBe("error");
        expect(r.error).toMatch(/ghost-skill-xyz/);

        expect(await fileExists(filePath)).toBe(true);

        // No RELATE or upsert calls - no partial writes
        expect(state.queries.filter((q) => q.sql.includes("RELATE")).length).toBe(0);
        expect(state.upserts.length).toBe(0);
    });

    // 5. --dry-run → no DB writes, no file removal
    it("dry-run: reports applied but makes no DB writes and no file removal", async () => {
        const taskDir = await createTaskDir("dryrun");
        const filePath = join(taskDir, "classify-worktree-read-strategy.md");
        await writeFile(filePath, FILLED_BRIEF, "utf8");

        const knownSkills = new Map([["worktree-read-strategy", "worktree-read-strategy"]]);
        const { db, state } = makeMockDb(knownSkills);

        const report = await runLintJson(db, { taskDir, dryRun: true });

        expect(report.dryRun).toBe(true);
        expect(report.applied).toBe(1);
        // File must remain (dry-run)
        expect(await fileExists(filePath)).toBe(true);

        // No RELATE, no upsert calls
        expect(state.queries.filter((q) => q.sql.includes("RELATE")).length).toBe(0);
        expect(state.queries.filter((q) => q.sql.includes("DELETE")).length).toBe(0);
        expect(state.upserts.length).toBe(0);
    });

    // 6. Idempotent: running lint twice = same end state
    it("idempotent: running lint twice leaves the same end state (files already removed after first run)", async () => {
        const taskDir = await createTaskDir("idempotent");
        const filePath = join(taskDir, "classify-worktree-read-strategy.md");
        await writeFile(filePath, FILLED_BRIEF, "utf8");

        const knownSkills = new Map([["worktree-read-strategy", "worktree-read-strategy"]]);
        const { db: db1 } = makeMockDb(knownSkills);
        const { db: db2, state: state2 } = makeMockDb(knownSkills);

        // First run: applies and removes the file
        const report1 = await runLintJson(db1, { taskDir });
        expect(report1.applied).toBe(1);
        expect(await fileExists(filePath)).toBe(false);

        // Second run: no files to process
        const report2 = await runLintJson(db2, { taskDir });
        expect(report2.applied).toBe(0);
        expect(report2.pending).toBe(0);
        expect(report2.errors).toBe(0);
        expect(state2.queries.filter((q) => q.sql.includes("RELATE")).length).toBe(0);
    });

    // 7. Edges use literal record id interpolation (not RecordId bindings)
    it("RELATE statements use literal record id strings, not variable bindings", async () => {
        const taskDir = await createTaskDir("literal-ids");
        const filePath = join(taskDir, "classify-worktree-read-strategy.md");
        await writeFile(filePath, FILLED_BRIEF, "utf8");

        const knownSkills = new Map([["worktree-read-strategy", "worktree-read-strategy"]]);
        const { db, state } = makeMockDb(knownSkills);

        await runLint(db, { taskDir });

        // RELATE SQL must embed the record ids as literals in the query string
        for (const q of state.queries.filter((q) => q.sql.includes("RELATE"))) {
            // Pattern: skill:`<key>`->plays_role->role:`<role>`
            expect(q.sql).toMatch(/RELATE skill:`[^`]+`->plays_role->role:`[^`]+`/);
            // Must NOT pass bindings for the skill/role ids
            expect(q.bindings).toBeUndefined();
        }
    });

    // 8. Deduplication: same role in primary and secondary only written once
    it("deduplicates roles across primary and secondary", async () => {
        const taskDir = await createTaskDir("dedup");
        const filePath = join(taskDir, "classify-worktree-read-strategy.md");
        await writeFile(filePath, DEDUP_BRIEF, "utf8");

        const knownSkills = new Map([["worktree-read-strategy", "worktree-read-strategy"]]);
        const { db, state } = makeMockDb(knownSkills);

        const report = await runLintJson(db, { taskDir });

        // DEDUP_BRIEF: primary=Framing, secondary=[FRAMING, execution]
        // After normalise: framing, execution → 2 edges
        expect(report.briefs[0]!.edgesWritten).toBe(2);
        const relateQueries = state.queries.filter((q) => q.sql.includes("RELATE"));
        expect(relateQueries.length).toBe(2);
    });

    // 9. Mixed briefs: filled + pending + error processed together
    it("processes multiple briefs correctly in one run", async () => {
        const taskDir = await createTaskDir("mixed");
        await writeFile(join(taskDir, "classify-worktree-read-strategy.md"), FILLED_BRIEF, "utf8");
        await writeFile(join(taskDir, "classify-some-skill.md"), PENDING_BRIEF, "utf8");
        await writeFile(join(taskDir, "classify-missing-field.md"), MALFORMED_BRIEF_NO_AX_CLASSIFY, "utf8");

        const knownSkills = new Map([["worktree-read-strategy", "worktree-read-strategy"]]);
        const { db } = makeMockDb(knownSkills);

        const report = await runLintJson(db, { taskDir });

        expect(report.applied).toBe(1);
        expect(report.pending).toBe(1);
        expect(report.errors).toBe(1);

        // Only the filled brief file should be gone
        expect(await fileExists(join(taskDir, "classify-worktree-read-strategy.md"))).toBe(false);
        expect(await fileExists(join(taskDir, "classify-some-skill.md"))).toBe(true);
        expect(await fileExists(join(taskDir, "classify-missing-field.md"))).toBe(true);
    });

    // 10. Non-existent task dir: returns clean report with zero briefs
    it("returns clean report when task dir does not exist", async () => {
        const { db } = makeMockDb(new Map());
        const report = await runLintJson(db, { taskDir: "/tmp/ax-nonexistent-dir-xyz-abc" });

        expect(report.applied).toBe(0);
        expect(report.pending).toBe(0);
        expect(report.errors).toBe(0);
        expect(report.briefs).toHaveLength(0);
    });

    // 11. Invalid primary_role (backtick injection) → error reported, file stays, no edges
    it("reports error for brief with invalid primary_role (backtick), file stays, no edges", async () => {
        const taskDir = await createTaskDir("invalid-role");
        const filePath = join(taskDir, "classify-my-skill.md");
        const brief = `---
ax_classify: my-skill
primary_role: "bad\`role"
secondary: []
---
`;
        await writeFile(filePath, brief, "utf8");

        const knownSkills = new Map([["my-skill", "my-skill"]]);
        const { db, state } = makeMockDb(knownSkills);

        const report = await runLintJson(db, { taskDir });

        expect(report.errors).toBe(1);
        expect(report.applied).toBe(0);
        const r = report.briefs[0]!;
        expect(r.action).toBe("error");
        expect(r.error).toMatch(/invalid role name/);

        // File must remain (error case)
        expect(await fileExists(filePath)).toBe(true);

        // No edges written
        expect(state.queries.filter((q) => q.sql.includes("RELATE")).length).toBe(0);
        expect(state.upserts.length).toBe(0);
    });

    // 12. Invalid ax_classify (semicolon injection) → error reported, file stays, no edges
    it("reports error for brief with invalid ax_classify (semicolon), file stays, no edges", async () => {
        const taskDir = await createTaskDir("invalid-skill");
        const filePath = join(taskDir, "classify-bad-skill.md");
        const brief = `---
ax_classify: "bad;skill name"
primary_role: framing
secondary: []
---
`;
        await writeFile(filePath, brief, "utf8");

        const { db, state } = makeMockDb(new Map());

        const report = await runLintJson(db, { taskDir });

        expect(report.errors).toBe(1);
        expect(report.applied).toBe(0);
        const r = report.briefs[0]!;
        expect(r.action).toBe("error");
        expect(r.error).toMatch(/invalid skill name/);

        expect(await fileExists(filePath)).toBe(true);
        expect(state.queries.filter((q) => q.sql.includes("RELATE")).length).toBe(0);
        expect(state.upserts.length).toBe(0);
    });

    // 13. Invalid secondary role entries are skipped (brief still applied with valid roles only)
    it("applies brief with mixed valid/invalid secondary roles, skipping invalid ones", async () => {
        const taskDir = await createTaskDir("invalid-secondary");
        const filePath = join(taskDir, "classify-my-skill.md");
        // primary=framing valid, secondary=[execution, "bad`role"] → execution kept, bad one skipped
        const brief = `---
ax_classify: my-skill
primary_role: framing
secondary:
  - execution
  - "bad\`role"
---
`;
        await writeFile(filePath, brief, "utf8");

        const knownSkills = new Map([["my-skill", "my-skill"]]);
        const { db, state } = makeMockDb(knownSkills);

        const report = await runLintJson(db, { taskDir });

        expect(report.applied).toBe(1);
        expect(report.errors).toBe(0);
        // primary=framing + secondary=execution = 2 edges (bad role skipped)
        expect(report.briefs[0]!.edgesWritten).toBe(2);

        const relateQueries = state.queries.filter((q) => q.sql.includes("RELATE"));
        expect(relateQueries.length).toBe(2);
        // Verify no backtick made it into any SQL
        for (const q of relateQueries) {
            expect(q.sql).not.toContain("`role`with");
        }
    });
});
