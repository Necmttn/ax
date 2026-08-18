import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { writeFileAtomic } from "@ax/lib/atomic-write";
import { parseFrontmatter, readList, setFrontmatterList } from "./frontmatter.ts";
import { addSkillToAgent, removeSkillFromAgent } from "./agent-scope-edit.ts";
import { reconcileTable, reconcileByScope } from "./reconcile.ts";
import { ConfigParseError } from "./errors.ts";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { TimestampColumn } from "@ax/lib/duckdb/columns";

const FS = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const runFs = <A, E>(eff: Effect.Effect<A, E, any>) =>
    Effect.runPromise(eff.pipe(Effect.provide(FS)) as Effect.Effect<A, E, never>);
/** Run, capturing failure as `{ ok:false, e }` (no `Effect.either` in this beta). */
const runFsResult = <A, E>(eff: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
        eff.pipe(
            Effect.match({
                onSuccess: (v) => ({ ok: true as const, v }),
                onFailure: (e) => ({ ok: false as const, e }),
            }),
            Effect.provide(FS),
        ) as Effect.Effect<{ ok: true; v: A } | { ok: false; e: E }, never, never>,
    );
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("frontmatter codec", () => {
    test("parse + readList tolerates block lists", () => {
        const { frontmatter, body, hasFrontmatter } = parseFrontmatter(
            "---\nname: a\nskills:\n  - x\n  - y\n---\nhello body\n",
        );
        expect(hasFrontmatter).toBe(true);
        expect(frontmatter.name).toBe("a");
        expect(readList(frontmatter, "skills")).toEqual(["x", "y"]);
        expect(body).toBe("hello body\n");
    });

    test("setFrontmatterList replaces only the targeted key, preserves rest", () => {
        const src = "---\nname: agent\ndescription: keep: me\nskills:\n  - old\n---\nBODY\n";
        const out = setFrontmatterList(src, "skills", ["a", "b"]);
        const p = parseFrontmatter(out);
        expect(readList(p.frontmatter, "skills")).toEqual(["a", "b"]);
        expect(p.frontmatter.name).toBe("agent");
        expect(p.body).toBe("BODY\n");
        expect(out).toContain("description: keep: me"); // untouched verbatim
    });

    test("setFrontmatterList drops the key when empty, inserts block when absent", () => {
        expect(setFrontmatterList("---\nname: a\nskills:\n  - x\n---\nB", "skills", [])).not.toContain("skills:");
        expect(setFrontmatterList("---\nname: a\n---\nB", "skills", ["z"])).toContain("- z");
    });
});

describe("writeFileAtomic", () => {
    test("writes, backs up prior file, leaves no .tmp", async () => {
        const dir = tmp("ax-aw-");
        const f = join(dir, "nested", "c.json");
        await runFs(writeFileAtomic(f, '{"v":1}'));
        expect(readFileSync(f, "utf8")).toBe('{"v":1}');
        await runFs(writeFileAtomic(f, '{"v":2}'));
        expect(readFileSync(f, "utf8")).toBe('{"v":2}');
        expect(readFileSync(`${f}.bak`, "utf8")).toBe('{"v":1}'); // prior content
        expect(readdirSync(join(dir, "nested")).some((n) => n.endsWith(".tmp"))).toBe(false);
    });

    test("validation failure writes nothing and leaves no .tmp", async () => {
        const dir = tmp("ax-aw-");
        const f = join(dir, "c.json");
        const res = await runFsResult(
            writeFileAtomic(f, "bad", {
                validate: () => Effect.fail(new ConfigParseError({ file: f, reason: "nope" })),
            }),
        );
        expect(res.ok).toBe(false);
        expect(existsSync(f)).toBe(false);
        expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
    });
});

describe("agent-scope-edit", () => {
    test("add + remove skill round-trips with .bak, body preserved", async () => {
        const dir = tmp("ax-agent-");
        const f = join(dir, "gtm.md");
        writeFileSync(f, "---\nname: gtm-prospector\ndescription: GTM\nskills:\n  - existing\n---\nPROMPT BODY\n");

        const a = await runFs(addSkillToAgent(f, "gtm-research"));
        expect(a.changed).toBe(true);
        expect(readList(parseFrontmatter(readFileSync(f, "utf8")).frontmatter, "skills")).toEqual([
            "existing",
            "gtm-research",
        ]);
        expect(readFileSync(f, "utf8")).toContain("PROMPT BODY");
        expect(existsSync(`${f}.bak`)).toBe(true);

        const r = await runFs(removeSkillFromAgent(f, "existing"));
        expect(r.skills).toEqual(["gtm-research"]);
    });

    test("adding an existing skill is a no-op (no write)", async () => {
        const dir = tmp("ax-agent-");
        const f = join(dir, "x.md");
        writeFileSync(f, "---\nname: x\nskills:\n  - dup\n---\nB\n");
        const a = await runFs(addSkillToAgent(f, "dup"));
        expect(a.changed).toBe(false);
        expect(existsSync(`${f}.bak`)).toBe(false); // never wrote
    });

    test("missing agent file -> ScopeTargetError", async () => {
        const dir = tmp("ax-agent-");
        const res = await runFsResult(addSkillToAgent(join(dir, "nope.md"), "s"));
        expect(res.ok).toBe(false);
        expect(!res.ok && (res.e as { _tag: string })._tag).toBe("ScopeTargetError");
    });
});

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("config reconcile", { requireFts: true });

const skill = (name: string, scope = "user", deletedAt: Date | null = null) => ({
    id: `${scope}-${name}`, name, scope, dir_path: `/skills/${name}`,
    content_hash: name, deleted_at: deletedAt,
});

describe("reconcileTable on real DuckDB", () => {
    dtest("tombstones absent rows, revives deleted rows, and touches live rows", async () => {
        let report: unknown;
        let rows: ReadonlyArray<{ name: string; deleted_at: Date | null }> = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-reconcile-live-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("skill", [
                    skill("keep"), skill("gone"), skill("revive", "user", new Date("2026-01-01")),
                    ...Array.from({ length: 8 }, (_, index) => skill(`live-${index}`)),
                ]);
                report = yield* reconcileTable(
                    write, "skill", ["keep", "revive", ...Array.from({ length: 8 }, (_, index) => `live-${index}`)],
                    { scope: "user" },
                );
                rows = yield* write.rows(
                    Schema.Struct({ name: Schema.String, deleted_at: Schema.NullOr(TimestampColumn) }),
                    "SELECT name, deleted_at FROM skill WHERE name IN ('gone', 'revive') ORDER BY name",
                );
            }),
        ));
        expect(report).toMatchObject({ tombstoned: 1, resurrected: 1, tombstoneSkipped: false });
        expect(rows[0]!.name).toBe("gone");
        expect(rows[0]!.deleted_at).toBeInstanceOf(Date);
        expect(rows[1]).toEqual({ name: "revive", deleted_at: null });
    });

    dtest("dry-run reports changes and does not mutate rows", async () => {
        let report: unknown;
        let deletedAt: Date | null = null;
        await runWithPlatform(publishCacheFixture(tempDir("ax-reconcile-dry-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("skill", [
                    skill("keep"), skill("gone"),
                    ...Array.from({ length: 8 }, (_, index) => skill(`live-${index}`)),
                ]);
                report = yield* reconcileTable(
                    write, "skill", ["keep", ...Array.from({ length: 8 }, (_, index) => `live-${index}`)],
                    { dryRun: true, scope: "user" },
                );
                const row = yield* write.first(
                    Schema.Struct({ deleted_at: Schema.NullOr(TimestampColumn) }),
                    "SELECT deleted_at FROM skill WHERE name = 'gone'",
                );
                deletedAt = row.pipe((option) => option._tag === "Some" ? option.value.deleted_at : null);
            }),
        ));
        expect(report).toMatchObject({ wouldTombstone: 1, tombstoned: 1, dryRun: true });
        expect(deletedAt).toBeNull();
    });

    dtest("refuses empty, incomplete, and implausible tombstone passes", async () => {
        const reports: unknown[] = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-reconcile-safe-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("skill", Array.from({ length: 10 }, (_, index) => skill(`row-${index}`)));
                reports.push(yield* reconcileTable(write, "skill", [], { scope: "user" }));
                reports.push(yield* reconcileTable(write, "skill", ["row-0"], { scope: "user", tombstone: false }));
                reports.push(yield* reconcileTable(write, "skill", ["row-0", "row-1"], { scope: "user" }));
            }),
        ));
        expect(reports).toEqual([
            expect.objectContaining({ tombstoneSkipped: true, skipReason: "empty", tombstoned: 0 }),
            expect.objectContaining({ tombstoneSkipped: true, skipReason: "incomplete", tombstoned: 0 }),
            expect.objectContaining({ tombstoneSkipped: true, skipReason: "implausible", tombstoned: 0 }),
        ]);
    });

    dtest("reconciles each owned scope independently", async () => {
        let report: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-reconcile-scope-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("skill", [skill("a"), skill("c", "plugin:x")]);
                report = yield* reconcileByScope(write, "skill", new Map([
                    ["user", ["a"]],
                    ["plugin:x", ["c"]],
                ]));
            }),
        ));
        expect(report).toMatchObject({
            table: "skill", tombstoned: 0, tombstoneSkipped: false,
            perScope: [{ scope: "user" }, { scope: "plugin:x" }],
        });
    });
});
