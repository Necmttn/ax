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
import { reconcileTable } from "./reconcile.ts";
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

    test("live run emits tombstone + resurrect + touch with $names binding", async () => {
        const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
        const layer = recordingDb(calls, [[1, 2], [3], [4, 5, 6]]); // tomb=2, revived=1, touched=3
        const report = await run(reconcileTable("skill", ["a", "b"]), layer);
        expect(report).toMatchObject({ table: "skill", tombstoned: 2, resurrected: 1, touched: 3, dryRun: false });
        expect(calls).toHaveLength(3);
        expect(calls[0]!.sql).toContain("SET deleted_at = time::now()");
        expect(calls[0]!.sql).toContain("NOT IN $names");
        expect(calls[0]!.bindings).toEqual({ names: ["a", "b"] });
        expect(calls[1]!.sql).toContain("deleted_at = NONE");
    });

    test("dry-run only SELECTs, never UPDATEs", async () => {
        const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
        const layer = recordingDb(calls, [[1], [], [2, 3]]);
        const report = await run(reconcileTable("agent_def", ["x"], { dryRun: true }), layer);
        expect(report).toMatchObject({ tombstoned: 1, resurrected: 0, touched: 2, dryRun: true });
        expect(calls.every((c) => c.sql.startsWith("SELECT"))).toBe(true);
    });
});
