import { describe, expect, test } from "bun:test";
import { Effect, type FileSystem, Layer, type Path, type PlatformError } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Judgment, type JudgmentError } from "@ax/lib/sqlite";
import { cmdSkillsClassify } from "./skills-classify.ts";
import { skillNameToSlug } from "./skills-classify-template.ts";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import { cacheReadResults } from "../testing/cache-read.ts";
import type { CacheRead } from "@ax/lib/duckdb/seam";

// ---------------------------------------------------------------------------
// Test fixtures - both cmdSkillsClassify backends (default = fetchSkillHygiene
// on CacheRead + Judgment, explicit = a single CacheRead join) live entirely
// on the DuckDB cache + SQLite judgment sidecar.
// ---------------------------------------------------------------------------

type MockRow = { name: string; invocations: number; sessions: number };

interface Fixture {
    readonly cacheRows: ReadonlyArray<ReadonlyArray<unknown>>;
    readonly classifiedIds: ReadonlyArray<string>;
}

/**
 * Default mode delegates to fetchSkillHygiene, which issues TWO cache reads
 * (invocation counts, skill catalog) joined in JS against a THIRD read from
 * the judgment sidecar (classified skill ids). `extraSkills` seeds skills
 * that should be filtered OUT (synthetic / classified / below-threshold) to
 * exercise the predicate end-to-end.
 */
function hygieneFixture(
    rows: MockRow[],
    extraSkills: Array<{
        name: string;
        invocations: number;
        sessions?: number;
        dir_path?: string;
        classified?: boolean;
    }> = [],
): Fixture {
    const all = [
        ...rows.map((r) => ({ ...r, dir_path: `/skills/${r.name}`, classified: false })),
        ...extraSkills.map((s) => ({
            name: s.name,
            invocations: s.invocations,
            sessions: s.sessions ?? 1,
            dir_path: s.dir_path ?? `/skills/${s.name}`,
            classified: s.classified ?? false,
        })),
    ];
    const counts = all.map((s) => ({ sid: `skill:${s.name}`, invocations: s.invocations, sessions: s.sessions }));
    const skills = all.map((s) => ({ id: `skill:${s.name}`, name: s.name, dir_path: s.dir_path, content_hash: null }));
    const classified = all.filter((s) => s.classified).map((s) => `skill:${s.name}`);
    return { cacheRows: [counts, skills], classifiedIds: classified };
}

/** Explicit mode: a single cache read (name/invocations/sessions row set). */
function explicitFixture(rows: MockRow[]): Fixture {
    return { cacheRows: [rows], classifiedIds: [] };
}

// Forced-dependency edit: cmdSkillsClassify requires FileSystem + Path (the
// @effect/platform migration); run against the REAL Bun-backed layers.
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

/** Builds a fresh CacheRead/Judgment layer pair from `fixture` for each call,
 *  so a fixture reused across two runWith invocations (e.g. idempotency
 *  tests that call cmdSkillsClassify twice) gets its own cache read index
 *  each time instead of sharing state across runs. */
const runWith = <A>(
    fixture: Fixture,
    eff: Effect.Effect<A, JudgmentError | PlatformError.PlatformError, Judgment | CacheRead | FileSystem.FileSystem | Path.Path>,
    capturedCacheSql: string[] = [],
): Promise<A> =>
    Effect.runPromise(
        eff.pipe(Effect.provide(Layer.mergeAll(
            cacheReadResults(fixture.cacheRows, capturedCacheSql),
            judgmentTestLayer(() => fixture.classifiedIds.map((skill_id) => ({ skill_id }))),
            BunFsLayer,
        ))),
    );

// ---------------------------------------------------------------------------
// skillNameToSlug (re-test via integration path)
// ---------------------------------------------------------------------------

describe("skillNameToSlug (slug helper)", () => {
    test("colon becomes double underscore", () => {
        expect(skillNameToSlug("superpowers:subagent-driven-development")).toBe(
            "superpowers__subagent-driven-development",
        );
    });
    test("plain name passes through", () => {
        expect(skillNameToSlug("pre-bash-guard")).toBe("pre-bash-guard");
    });
});

// ---------------------------------------------------------------------------
// cmdSkillsClassify - default mode
// ---------------------------------------------------------------------------

describe("cmdSkillsClassify default mode", () => {
    test("writes a classify-<slug>.md for each returned row", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-"));
        const rows: MockRow[] = [
            { name: "composto", invocations: 15, sessions: 4 },
            { name: "codex:rescue", invocations: 8, sessions: 3 },
        ];
        const fixture = hygieneFixture(rows);
        await runWith(fixture, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));

        for (const row of rows) {
            const slug = skillNameToSlug(row.name);
            const filePath = join(outDir, `classify-${slug}.md`);
            const content = await readFile(filePath, "utf8");
            expect(content).toContain(`# ax classify: ${row.name}`);
            expect(content).toContain(`${row.invocations} invocations`);
            expect(content).toContain(`${row.sessions} sessions`);
        }
    });

    // Regression for the dead-end loop: default mode must SELECT unclassified
    // skills with ≥3 invocations and exclude classified / synthetic / low-count.
    // The previous correlated `NOT (subquery)[0]` predicate returned NONE (not
    // false) for unclassified skills and silently excluded every one of them, so
    // classify always reported "none found" while `ax skills weighted` reported
    // a positive count. Now both share fetchSkillHygiene.
    test("selects unclassified ≥3 and drops classified / synthetic / low-count", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-filter-"));
        const fixture = hygieneFixture(
            [{ name: "keep-me", invocations: 9, sessions: 3 }],
            [
                { name: "already-tagged", invocations: 20, classified: true },
                { name: "codex:exec", invocations: 999, dir_path: "(synthetic)" },
                { name: "too-rare", invocations: 2 },
            ],
        );
        const logged: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => { logged.push(msg); };
        try {
            await runWith(fixture, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: true }));
        } finally {
            console.log = origLog;
        }
        const parsed = JSON.parse(logged[0] ?? "[]") as Array<Record<string, unknown>>;
        expect(parsed.map((r) => r.skill)).toEqual(["keep-me"]);
    });

    test("is idempotent - skips existing files without re-writing", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-idem-"));
        const rows: MockRow[] = [{ name: "composto", invocations: 15, sessions: 4 }];
        const fixture = hygieneFixture(rows);

        // First run - write the file
        await runWith(fixture, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));
        const filePath = join(outDir, `classify-composto.md`);
        const firstContent = await readFile(filePath, "utf8");

        // Manually mutate the file to confirm second run doesn't overwrite
        await Bun.write(filePath, "sentinel content");

        // Second run - should skip
        await runWith(fixture, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));
        const secondContent = await readFile(filePath, "utf8");
        expect(secondContent).toBe("sentinel content");
        expect(firstContent).not.toBe("sentinel content");
    });

    test("dry-run does not write any files", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-dry-"));
        const rows: MockRow[] = [{ name: "composto", invocations: 15, sessions: 4 }];
        const fixture = hygieneFixture(rows);
        await runWith(fixture, cmdSkillsClassify({ names: [], outDir, dryRun: true, json: false }));
        const filePath = join(outDir, `classify-composto.md`);
        const exists = await access(filePath).then(() => true, () => false);
        expect(exists).toBe(false);
    });

    test("json mode outputs structured list, no files written", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-json-"));
        const rows: MockRow[] = [{ name: "composto", invocations: 15, sessions: 4 }];
        const fixture = hygieneFixture(rows);

        const logged: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => { logged.push(msg); };
        try {
            await runWith(fixture, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: true }));
        } finally {
            console.log = origLog;
        }

        expect(logged.length).toBe(1);
        const parsed = JSON.parse(logged[0]) as Array<Record<string, unknown>>;
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed[0]?.skill).toBe("composto");
        expect(typeof parsed[0]?.path).toBe("string");
        expect((parsed[0]?.path as string)).toContain("classify-composto.md");

        // No files written
        const filePath = join(outDir, `classify-composto.md`);
        const exists = await access(filePath).then(() => true, () => false);
        expect(exists).toBe(false);
    });

    test("empty result from DB prints informational message", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-empty-"));
        const fixture = hygieneFixture([]);
        const logged: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => { logged.push(msg); };
        try {
            await runWith(fixture, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));
        } finally {
            console.log = origLog;
        }
        expect(logged.join(" ")).toContain("no unclassified skills");
    });
});

// ---------------------------------------------------------------------------
// cmdSkillsClassify - explicit mode (names provided)
// ---------------------------------------------------------------------------

describe("cmdSkillsClassify explicit mode", () => {
    test("queries the named skills (SQL contains the name IN clause)", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-explicit-"));
        const captured: string[] = [];
        const fixture = explicitFixture([{ name: "composto", invocations: 5, sessions: 2 }]);
        await runWith(fixture, cmdSkillsClassify({ names: ["composto"], outDir, dryRun: false, json: false }), captured);
        const capturedSql = captured.at(-1) ?? "";
        expect(capturedSql).toContain("IN (?)");
        expect(capturedSql).toContain("skill");
        // Explicit mode should NOT filter out already-classified skills
        expect(capturedSql).not.toContain("plays_role");
    });

    test("emits brief for already-classified skill (re-classification)", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-reclassify-"));
        // Cache returns the skill even though it already has a plays_role edge
        // (the SQL no longer filters it out in explicit mode)
        const rows: MockRow[] = [{ name: "composto", invocations: 20, sessions: 8 }];
        const fixture = explicitFixture(rows);
        await runWith(fixture, cmdSkillsClassify({ names: ["composto"], outDir, dryRun: false, json: false }));
        const filePath = join(outDir, `classify-composto.md`);
        const exists = await access(filePath).then(() => true, () => false);
        expect(exists).toBe(true);
        const content = await readFile(filePath, "utf8");
        expect(content).toContain("# ax classify: composto");
    });

    test("writes brief for explicitly-named skill with fewer than 3 invocations", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-low-inv-"));
        const rows: MockRow[] = [{ name: "my-skill", invocations: 1, sessions: 1 }];
        const fixture = explicitFixture(rows);
        await runWith(fixture, cmdSkillsClassify({ names: ["my-skill"], outDir, dryRun: false, json: false }));
        const filePath = join(outDir, `classify-my-skill.md`);
        const exists = await access(filePath).then(() => true, () => false);
        expect(exists).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// SQL predicate shape verification
// ---------------------------------------------------------------------------

describe("SQL shape (default mode)", () => {
    // Default mode delegates to fetchSkillHygiene, whose deref-free 3-statement
    // query reads the classified set from plays_role (the role-source filter) and
    // joins counts→skills in JS. The ≥3 threshold and synthetic exclusion are
    // applied in JS (see fetchSkillHygiene), NOT in SQL - so they are asserted by
    // the behavioral filter test above, not by string-matching the query.
    test("default cache query does not read judgment role tables", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-sql-"));
        const captured: string[] = [];
        const fixture = hygieneFixture([]);
        await runWith(fixture, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }), captured);
        // The role decision comes from the sidecar; the cache SQL may never
        // reach for `plays_role`.
        const capturedCache = captured.join("\n");
        expect(capturedCache).not.toContain("plays_role");
        expect(capturedCache).toContain("invoked");
    });
});

// ---------------------------------------------------------------------------
// File path shape
// ---------------------------------------------------------------------------

describe("output path", () => {
    test("uses .ax/tasks as default out-dir in the path suffix", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-path-"));
        const rows: MockRow[] = [
            { name: "superpowers:subagent-driven-development", invocations: 10, sessions: 5 },
        ];
        const fixture = hygieneFixture(rows);
        await runWith(fixture, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));
        const expectedFile = join(outDir, "classify-superpowers__subagent-driven-development.md");
        const exists = await access(expectedFile).then(() => true, () => false);
        expect(exists).toBe(true);
    });
});
