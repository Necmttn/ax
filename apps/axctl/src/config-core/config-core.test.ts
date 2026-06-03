import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SurrealClient } from "@ax/lib/db";
import { writeFileAtomic } from "@ax/lib/atomic-write";
import { parseFrontmatter, readList, setFrontmatterList } from "./frontmatter.ts";
import { addSkillToAgent, removeSkillFromAgent } from "./agent-scope-edit.ts";
import { reconcileTable, reconcileByScope } from "./reconcile.ts";
import { ConfigParseError } from "./errors.ts";

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

describe("reconcileTable", () => {
    const recordingDb = (calls: { sql: string; bindings?: Record<string, unknown> | undefined }[], rows: unknown[][]) => {
        let i = 0;
        return Layer.succeed(SurrealClient, {
            query: <T>(sql: string, bindings?: Record<string, unknown>) => {
                calls.push({ sql, bindings });
                return Effect.succeed([rows[i++] ?? []] as unknown as T);
            },
            upsert: () => Effect.void,
            relate: () => Effect.void,
            putFile: () => Effect.void,
            getFile: () => Effect.succeed(""),
            raw: undefined as never,
        } as never);
    };
    const run = <A, E>(eff: Effect.Effect<A, E, SurrealClient>, layer: Layer.Layer<SurrealClient>) =>
        Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

    // query order: SELECT absent, SELECT live, [UPDATE absent], UPDATE revivable, UPDATE live
    test("live run: pre-selects then tombstone/resurrect/touch with $names binding", async () => {
        const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
        // wouldTombstone=1, livePresent=9 -> liveTotal=10, 1/10 < 0.5 so not skipped
        const layer = recordingDb(calls, [[1], [1, 2, 3, 4, 5, 6, 7, 8, 9], [1], [7], [1, 2, 3, 4, 5, 6, 7, 8, 9]]);
        const report = await run(reconcileTable("skill", ["a", "b"]), layer);
        expect(report).toMatchObject({ table: "skill", tombstoned: 1, resurrected: 1, touched: 9, dryRun: false, tombstoneSkipped: false, wouldTombstone: 1 });
        expect(calls[0]!.sql).toStartWith("SELECT"); // wouldTombstone probe
        expect(calls[0]!.bindings).toEqual({ names: ["a", "b"] });
        expect(calls[2]!.sql).toContain("SET deleted_at = time::now()");
        expect(calls[2]!.sql).toContain("NOT IN $names");
        expect(calls[3]!.sql).toContain("deleted_at = NONE");
    });

    test("dry-run never UPDATEs", async () => {
        const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
        const layer = recordingDb(calls, [[1], [2, 3, 4], [9]]); // would=1, present=3, revivable=1
        const report = await run(reconcileTable("agent_def", ["x"], { dryRun: true }), layer);
        expect(report).toMatchObject({ tombstoned: 1, resurrected: 1, touched: 3, dryRun: true, tombstoneSkipped: false });
        expect(calls.every((c) => c.sql.startsWith("SELECT"))).toBe(true);
    });

    test("SAFETY: refuses to tombstone an implausible share of the table", async () => {
        const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
        // wouldTombstone=8, livePresent=2 -> 8/10 = 0.8 > 0.5 -> implausible, skipped
        const layer = recordingDb(calls, [[1, 2, 3, 4, 5, 6, 7, 8], [1, 2]]);
        const report = await run(reconcileTable("skill", ["a", "b"]), layer);
        expect(report).toMatchObject({ tombstoned: 0, tombstoneSkipped: true, skipReason: "implausible", wouldTombstone: 8 });
        expect(calls.some((c) => c.sql.startsWith("UPDATE") && c.sql.includes("deleted_at = time::now()"))).toBe(false);
    });

    test("SAFETY: empty snapshot tombstones nothing", async () => {
        const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
        const layer = recordingDb(calls, [[1, 2, 3], []]);
        const report = await run(reconcileTable("skill", []), layer);
        expect(report).toMatchObject({ tombstoned: 0, tombstoneSkipped: true, skipReason: "empty" });
    });

    test("SAFETY: tombstone:false (degraded discovery) skips the destructive pass", async () => {
        const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
        const layer = recordingDb(calls, [[1], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]);
        const report = await run(reconcileTable("skill", ["a"], { tombstone: false }), layer);
        expect(report).toMatchObject({ tombstoned: 0, tombstoneSkipped: true, skipReason: "incomplete" });
    });

    test("scoped: a scope constrains every predicate to `scope = $scope`", async () => {
        const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
        const layer = recordingDb(calls, [[1], [1, 2, 3, 4, 5, 6, 7, 8, 9], [1], [], [1, 2, 3, 4, 5, 6, 7, 8, 9]]);
        await run(reconcileTable("skill", ["a"], { scope: "user" }), layer);
        expect(calls.every((c) => c.sql.includes("scope = $scope"))).toBe(true);
        expect(calls.every((c) => (c.bindings as { scope?: string }).scope === "user")).toBe(true);
    });

    test("reconcileByScope reconciles each scope independently, never cross-scope", async () => {
        const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
        // 2 scopes x 5 queries = 10; all would=0 so nothing is skipped.
        const layer = recordingDb(calls, Array.from({ length: 10 }, () => [] as unknown[]));
        const byScope = new Map<string, string[]>([
            ["user", ["a", "b"]],
            ["plugin:x", ["c"]],
        ]);
        const report = await run(reconcileByScope("skill", byScope), layer);
        expect(report.perScope.map((p) => p.scope)).toEqual(["user", "plugin:x"]);
        // every query is scope-constrained - a `user` reconcile can't touch `plugin:x`.
        expect(calls.every((c) => c.sql.includes("scope = $scope"))).toBe(true);
        const scopes = new Set(calls.map((c) => (c.bindings as { scope?: string }).scope));
        expect([...scopes].sort()).toEqual(["plugin:x", "user"]);
        expect(report).toMatchObject({ table: "skill", tombstoned: 0, tombstoneSkipped: false });
    });
});
