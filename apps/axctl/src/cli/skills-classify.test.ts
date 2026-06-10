import { describe, expect, test } from "bun:test";
import { Effect, type FileSystem, Layer, type Path, type PlatformError } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { cmdSkillsClassify } from "./skills-classify.ts";
import { skillNameToSlug } from "./skills-classify-template.ts";
import { DbError } from "@ax/lib/errors";

// ---------------------------------------------------------------------------
// Test fixtures + mock DB
// ---------------------------------------------------------------------------

type MockRow = { name: string; invocations: number; sessions: number };

/** Build a minimal SurrealClientShape mock that returns a fixed row list. */
function mockDb(rows: MockRow[]): SurrealClientShape {
    return makeTestSurrealClient({ denyWrites: true, fallback: [rows] }).client;
}

// Forced-dependency edit: cmdSkillsClassify now requires FileSystem + Path
// (the @effect/platform migration); run against the REAL Bun-backed layers.
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const runWith = <A>(
    db: SurrealClientShape,
    eff: Effect.Effect<A, DbError | PlatformError.PlatformError, SurrealClient | FileSystem.FileSystem | Path.Path>,
): Promise<A> =>
    Effect.runPromise(
        eff.pipe(Effect.provideService(SurrealClient, db), Effect.provide(BunFsLayer)),
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
        const db = mockDb(rows);
        await runWith(db, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));

        for (const row of rows) {
            const slug = skillNameToSlug(row.name);
            const filePath = join(outDir, `classify-${slug}.md`);
            const content = await readFile(filePath, "utf8");
            expect(content).toContain(`# ax classify: ${row.name}`);
            expect(content).toContain(`${row.invocations} invocations`);
            expect(content).toContain(`${row.sessions} sessions`);
        }
    });

    test("is idempotent - skips existing files without re-writing", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-idem-"));
        const rows: MockRow[] = [{ name: "composto", invocations: 15, sessions: 4 }];
        const db = mockDb(rows);

        // First run - write the file
        await runWith(db, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));
        const filePath = join(outDir, `classify-composto.md`);
        const firstContent = await readFile(filePath, "utf8");

        // Manually mutate the file to confirm second run doesn't overwrite
        await Bun.write(filePath, "sentinel content");

        // Second run - should skip
        await runWith(db, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));
        const secondContent = await readFile(filePath, "utf8");
        expect(secondContent).toBe("sentinel content");
        expect(firstContent).not.toBe("sentinel content");
    });

    test("dry-run does not write any files", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-dry-"));
        const rows: MockRow[] = [{ name: "composto", invocations: 15, sessions: 4 }];
        const db = mockDb(rows);
        await runWith(db, cmdSkillsClassify({ names: [], outDir, dryRun: true, json: false }));
        const filePath = join(outDir, `classify-composto.md`);
        const exists = await access(filePath).then(() => true, () => false);
        expect(exists).toBe(false);
    });

    test("json mode outputs structured list, no files written", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-json-"));
        const rows: MockRow[] = [{ name: "composto", invocations: 15, sessions: 4 }];
        const db = mockDb(rows);

        const logged: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => { logged.push(msg); };
        try {
            await runWith(db, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: true }));
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
        const db = mockDb([]);
        const logged: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => { logged.push(msg); };
        try {
            await runWith(db, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));
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
    test("queries the named skills (SQL contains the name)", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-explicit-"));
        const tc = makeTestSurrealClient({
            denyWrites: true,
            fallback: [[{ name: "composto", invocations: 5, sessions: 2 }]],
        });
        await runWith(tc.client, cmdSkillsClassify({ names: ["composto"], outDir, dryRun: false, json: false }));
        const capturedSql = tc.captured.at(-1) ?? "";
        expect(capturedSql).toContain('"composto"');
        // Explicit mode should NOT contain the >= 3 threshold
        expect(capturedSql).not.toContain(">= 3");
        // Explicit mode should NOT filter out already-classified skills
        expect(capturedSql).not.toContain("plays_role");
    });

    test("emits brief for already-classified skill (re-classification)", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-reclassify-"));
        // DB returns the skill even though it already has a plays_role edge
        // (the SQL no longer filters it out in explicit mode)
        const rows: MockRow[] = [{ name: "composto", invocations: 20, sessions: 8 }];
        const db = mockDb(rows);
        await runWith(db, cmdSkillsClassify({ names: ["composto"], outDir, dryRun: false, json: false }));
        const filePath = join(outDir, `classify-composto.md`);
        const exists = await access(filePath).then(() => true, () => false);
        expect(exists).toBe(true);
        const content = await readFile(filePath, "utf8");
        expect(content).toContain("# ax classify: composto");
    });

    test("writes brief for explicitly-named skill with fewer than 3 invocations", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-low-inv-"));
        const rows: MockRow[] = [{ name: "my-skill", invocations: 1, sessions: 1 }];
        const db = mockDb(rows);
        await runWith(db, cmdSkillsClassify({ names: ["my-skill"], outDir, dryRun: false, json: false }));
        const filePath = join(outDir, `classify-my-skill.md`);
        const exists = await access(filePath).then(() => true, () => false);
        expect(exists).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// SQL predicate shape verification
// ---------------------------------------------------------------------------

describe("SQL shape (default mode)", () => {
    test("default query requires invocations >= 3 and NOT plays_role", async () => {
        const outDir = mkdtempSync(join(tmpdir(), "ax-classify-sql-"));
        const tc = makeTestSurrealClient({ denyWrites: true });
        await runWith(tc.client, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));
        const capturedSql = tc.captured.at(-1) ?? "";
        expect(capturedSql).toContain("plays_role");
        expect(capturedSql).toContain(">= 3");
        expect(capturedSql).toContain(`"frontmatter"`);
        expect(capturedSql).toContain(`"brief"`);
        expect(capturedSql).toContain(`"user"`);
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
        const db = mockDb(rows);
        await runWith(db, cmdSkillsClassify({ names: [], outDir, dryRun: false, json: false }));
        const expectedFile = join(outDir, "classify-superpowers__subagent-driven-development.md");
        const exists = await access(expectedFile).then(() => true, () => false);
        expect(exists).toBe(true);
    });
});
