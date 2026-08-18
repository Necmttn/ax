import { afterEach, describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Option, Schema } from "effect";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";
import { Judgment, JudgmentLayer, TextColumn } from "@ax/lib/sqlite";
import { skillRowId } from "@ax/lib/stable-id";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { cmdSkillsLint, parseBrief, type LintReport } from "./skills-lint.ts";

const FILLED_BRIEF = `---
ax_classify: worktree-read-strategy
primary_role: framing
secondary: [execution, repair]
confidence: 0.8
rationale: This skill frames the approach before reading.
---
`;

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const tempDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "ax-skills-lint-"));
    directories.push(directory);
    return directory;
};

const fileExists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

const cacheLayer = (knownSkills: ReadonlySet<string>) =>
    Layer.succeed(CacheRead, {
        snapshotPath: "/test/snapshot.duckdb",
        rows: () => Effect.succeed([]),
        raw: () => Effect.succeed({ columns: [], rows: [], rowsChanged: 0 }),
        first: (_schema, _sql, params) => {
            const name = String(params?.[0] ?? "");
            return Effect.succeed(
                knownSkills.has(name)
                    ? Option.some({ id: skillRowId(name) })
                    : Option.none(),
            );
        },
    } as CacheReadService);

const runLintJson = async (
    directory: string,
    knownSkills: ReadonlySet<string>,
    options: { readonly dryRun?: boolean } = {},
): Promise<LintReport> => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
        await Effect.runPromise(
            cmdSkillsLint({
                taskDir: join(directory, "tasks"),
                dryRun: options.dryRun ?? false,
                json: true,
            }).pipe(
                Effect.provide(
                    Layer.mergeAll(
                        BunFileSystem.layer,
                        BunPath.layer,
                        cacheLayer(knownSkills),
                        JudgmentLayer({
                            sidecarPath: join(directory, "judgment.sqlite"),
                            schemaSql: SIDECAR_SCHEMA_SQL,
                        }),
                    ),
                ),
                Effect.scoped,
            ),
        );
    } finally {
        console.log = original;
    }
    return JSON.parse(lines.join("\n")) as LintReport;
};

const roleNames = (directory: string) =>
    Effect.runPromise(
        Effect.gen(function* () {
            const judgment = yield* Judgment;
            return yield* judgment.rows(
                Schema.Struct({ name: TextColumn }),
                `SELECT r.name
                 FROM plays_role p JOIN role r ON r.id = p.out_id
                 WHERE p.source = 'brief'
                 ORDER BY r.name`,
            );
        }).pipe(
            Effect.provide(
                JudgmentLayer({
                    sidecarPath: join(directory, "judgment.sqlite"),
                    schemaSql: SIDECAR_SCHEMA_SQL,
                }),
            ),
            Effect.scoped,
        ),
    );

describe("parseBrief", () => {
    test("normalizes and deduplicates valid roles", () => {
        const parsed = parseBrief(`---
ax_classify: tdd
primary_role: Framing
secondary: [FRAMING, execution, "bad\`role"]
confidence: 0.7
---
`, "brief.md");
        expect(parsed).toEqual({
            ax_classify: "tdd",
            primary_role: "framing",
            secondary: ["framing", "execution"],
            confidence: 0.7,
            rationale: undefined,
        });
    });

    test("keeps an empty primary role pending", () => {
        expect(parseBrief(`---\nax_classify: tdd\nprimary_role:\nsecondary: []\n---\n`, "brief.md")).toBeNull();
    });

    test("rejects malformed and unsafe fields", () => {
        expect(parseBrief("# no frontmatter", "brief.md")).toEqual({ error: "no YAML frontmatter found in brief.md" });
        expect(parseBrief(`---\nprimary_role: framing\n---\n`, "brief.md")).toEqual({
            error: "missing or empty ax_classify in brief.md",
        });
        expect(parseBrief(`---\nax_classify: bad;skill\nprimary_role: framing\n---\n`, "brief.md")).toEqual({
            error: "invalid skill name \"bad;skill\" in ax_classify of brief.md (must be alphanumeric, _ or -, optionally plugin:namespaced)",
        });
    });
});

describe("cmdSkillsLint", () => {
    test("replaces brief roles in SQLite and removes the applied file", async () => {
        const directory = await tempDirectory();
        const taskDir = join(directory, "tasks");
        const file = join(taskDir, "classify-worktree-read-strategy.md");
        await mkdir(taskDir, { recursive: true });
        await writeFile(file, FILLED_BRIEF);

        const report = await runLintJson(directory, new Set(["worktree-read-strategy"]));

        expect(report).toMatchObject({ applied: 1, pending: 0, errors: 0, dryRun: false });
        expect(report.briefs[0]).toMatchObject({ action: "applied", edgesWritten: 3 });
        expect((await roleNames(directory)).map((row) => row.name)).toEqual(["execution", "framing", "repair"]);
        expect(await fileExists(file)).toBe(false);
    });

    test("keeps pending, malformed, and unknown-skill briefs", async () => {
        const directory = await tempDirectory();
        const taskDir = join(directory, "tasks");
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, "classify-pending.md"), `---\nax_classify: pending\nprimary_role:\n---\n`);
        await writeFile(join(taskDir, "classify-malformed.md"), "# no frontmatter");
        await writeFile(join(taskDir, "classify-unknown.md"), `---\nax_classify: unknown\nprimary_role: framing\n---\n`);

        const report = await runLintJson(directory, new Set());

        expect(report).toMatchObject({ applied: 0, pending: 1, errors: 2 });
        expect(await roleNames(directory)).toEqual([]);
        expect(await fileExists(join(taskDir, "classify-pending.md"))).toBe(true);
        expect(await fileExists(join(taskDir, "classify-malformed.md"))).toBe(true);
        expect(await fileExists(join(taskDir, "classify-unknown.md"))).toBe(true);
    });

    test("dry-run checks identity but does not write or remove", async () => {
        const directory = await tempDirectory();
        const taskDir = join(directory, "tasks");
        const file = join(taskDir, "classify-worktree-read-strategy.md");
        await mkdir(taskDir, { recursive: true });
        await writeFile(file, FILLED_BRIEF);

        const report = await runLintJson(directory, new Set(["worktree-read-strategy"]), { dryRun: true });

        expect(report).toMatchObject({ applied: 1, errors: 0, dryRun: true });
        expect(await roleNames(directory)).toEqual([]);
        expect(await fileExists(file)).toBe(true);
    });
});
