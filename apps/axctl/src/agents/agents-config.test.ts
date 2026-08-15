import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { userSource, projectSource } from "./source.ts";
import { AgentSourceRegistryFrom } from "./registry.ts";
import { scopeAgent, readAllAgents } from "./config.ts";
import { reconcileAgents } from "./reconcile.ts";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const FS = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

let prevAgentDirs: string | undefined;
let dir: string;

beforeEach(() => {
    prevAgentDirs = process.env.AX_AGENT_DIRS;
    dir = mkdtempSync(join(tmpdir(), "ax-agents-"));
    process.env.AX_AGENT_DIRS = dir;
});

afterEach(() => {
    if (prevAgentDirs === undefined) delete process.env.AX_AGENT_DIRS;
    else process.env.AX_AGENT_DIRS = prevAgentDirs;
});

const writeAgent = (name: string, body: string) =>
    writeFileSync(join(dir, `${name}.md`), body);

const reg = () => AgentSourceRegistryFrom([userSource]);

describe("agent source discover", () => {
    test("parses frontmatter into AgentRecord[]", async () => {
        writeAgent(
            "reviewer",
            "---\nname: reviewer\ndescription: reviews code\nmodel: opus\nskills:\n  - tdd\n  - commit\n---\nYou review code.\n",
        );
        writeAgent("plain", "no frontmatter here, just prose");

        const recs = await Effect.runPromise(
            userSource.discover(undefined).pipe(Effect.provide(FS)),
        );
        const byName = new Map(recs.map((r) => [r.name, r]));
        const reviewer = byName.get("reviewer")!;
        expect(reviewer.scope).toBe("user");
        expect(reviewer.scopeTag).toBe("user"); // user scope tag is plain "user"
        expect(reviewer.description).toBe("reviews code");
        expect(reviewer.model).toBe("opus");
        expect(reviewer.skills).toEqual(["commit", "tdd"]); // sorted+deduped
        expect(reviewer.contentHash.length).toBe(16);
        // No-frontmatter file still yields a record keyed by filename stem.
        expect(byName.has("plain")).toBe(true);
        expect(byName.get("plain")!.skills).toEqual([]);
    });

    test("project source emits a repo-qualified scopeTag (project:<repo>)", async () => {
        const repo = mkdtempSync(join(tmpdir(), "myrepo-"));
        mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
        writeFileSync(join(repo, ".claude", "agents", "p.md"), "---\nname: p\n---\nbody");
        const recs = await Effect.runPromise(
            projectSource.discover(repo).pipe(Effect.provide(FS)),
        );
        expect(recs[0]!.scope).toBe("project"); // kind
        expect(recs[0]!.scopeTag).toBe(`project:${repo.split("/").filter(Boolean).pop()}`); // repo-qualified
    });

    test("skips parked sidecars", async () => {
        writeAgent("kept", "---\nname: kept\n---\nbody");
        writeFileSync(join(dir, "gone.md.ax-parked"), "---\nname: gone\n---\nbody");
        const recs = await Effect.runPromise(
            userSource.discover(undefined).pipe(Effect.provide(FS)) as Effect.Effect<any, never, never>,
        );
        const names = (recs as { name: string }[]).map((r) => r.name);
        expect(names).toContain("kept");
        expect(names).not.toContain("gone");
    });
});

describe("agents scope round-trip (real fs)", () => {
    const baseAgent =
        "---\nname: reviewer\ndescription: reviews code\nskills:\n  - tdd\n---\nThe body must survive verbatim.\n";

    test("adds a skill, writes a .bak, preserves body", async () => {
        writeAgent("reviewer", baseAgent);
        const file = join(dir, "reviewer.md");

        const res = await Effect.runPromise(
            scopeAgent("reviewer", "commit").pipe(
                Effect.provide(Layer.mergeAll(FS, reg())),
            ) as Effect.Effect<any, never, never>,
        );
        expect((res as { changed: boolean }).changed).toBe(true);
        expect((res as { skills: string[] }).skills).toEqual(["commit", "tdd"]);

        const after = readFileSync(file, "utf8");
        expect(after).toContain("- commit");
        expect(after).toContain("- tdd");
        expect(after).toContain("The body must survive verbatim.");
        expect(after).toContain("description: reviews code");
        // Atomic write leaves a .bak of the prior content.
        expect(existsSync(`${file}.bak`)).toBe(true);
        expect(readFileSync(`${file}.bak`, "utf8")).toBe(baseAgent);
    });

    test("removes a skill", async () => {
        writeAgent(
            "reviewer",
            "---\nname: reviewer\nskills:\n  - tdd\n  - commit\n---\nbody\n",
        );
        const file = join(dir, "reviewer.md");
        const res = await Effect.runPromise(
            scopeAgent("reviewer", "commit", { remove: true }).pipe(
                Effect.provide(Layer.mergeAll(FS, reg())),
            ) as Effect.Effect<any, never, never>,
        );
        expect((res as { skills: string[] }).skills).toEqual(["tdd"]);
        const after = readFileSync(file, "utf8");
        expect(after).not.toContain("- commit");
        expect(after).toContain("- tdd");
    });

    test("scoping an unknown agent fails with AgentNotFoundError", async () => {
        writeAgent("reviewer", baseAgent);
        const result = await Effect.runPromise(
            scopeAgent("ghost", "commit").pipe(
                Effect.match({
                    onSuccess: () => ({ ok: true as const }),
                    onFailure: (e) => ({ ok: false as const, tag: (e as { _tag: string })._tag }),
                }),
                Effect.provide(Layer.mergeAll(FS, reg())),
            ) as Effect.Effect<{ ok: true } | { ok: false; tag: string }, never, never>,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.tag).toBe("AgentNotFoundError");
    });
});


const { dylibPath, dtest, tempDir } = await duckdbTestSetup("agent config", { requireFts: true });

const agentRow = (name: string, deletedAt: Date | null = null) => ({
    id: name, name, scope: "user", dir_path: `/agents/${name}.md`,
    skills: "[]", content_hash: name, deleted_at: deletedAt,
});

describe("agent database behavior on real DuckDB", () => {
    dtest("reconcile discovers names and updates lifecycle rows", async () => {
        writeAgent("reviewer", "---\nname: reviewer\n---\nbody");
        writeAgent("planner", "---\nname: planner\n---\nbody");
        let report: unknown;
        let goneDeleted = false;
        await runWithPlatform(publishCacheFixture(tempDir("ax-agent-reconcile-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("agent_def", [
                    agentRow("reviewer"), agentRow("planner"), agentRow("gone"),
                    ...Array.from({ length: 8 }, (_, index) => agentRow(`extra-${index}`)),
                ]);
                for (let index = 0; index < 8; index += 1) {
                    writeAgent(`extra-${index}`, `---\nname: extra-${index}\n---\nbody`);
                }
                report = yield* reconcileAgents(write).pipe(
                    Effect.provide(Layer.mergeAll(FS, reg())),
                );
                const rows = yield* write.raw("SELECT deleted_at FROM agent_def WHERE name = 'gone'");
                goneDeleted = rows.rows[0]?.deleted_at instanceof Date;
            }),
        ));
        expect(report).toMatchObject({ table: "agent_def", tombstoned: 1, tombstoneSkipped: false });
        expect(goneDeleted).toBe(true);
    });

    dtest("readAllAgents joins disk records to live and deleted graph rows", async () => {
        writeAgent("reviewer", "---\nname: reviewer\nskills:\n  - tdd\n---\nbody");
        writeAgent("planner", "---\nname: planner\n---\nbody");
        const fixture = await runWithPlatform(publishCacheFixture(
            tempDir("ax-agent-read-"), dylibPath,
            (write) => write.putMany("agent_def", [
                agentRow("reviewer"), agentRow("stale", new Date("2026-01-01")),
            ]),
        ));
        const rows = await runWithPlatform(
            readAllAgents({ includeDeleted: true }).pipe(
                Effect.provide(Layer.mergeAll(readFixture(fixture.snapshotPath, dylibPath), FS, reg())),
            ),
        );
        expect(new Map(rows.map((row) => [row.name, row.status]))).toEqual(new Map([
            ["planner", "uningested"],
            ["reviewer", "live"],
            ["stale", "deleted"],
        ]));
    });
});
