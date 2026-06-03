import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SurrealClient } from "@ax/lib/db";
import { userSource } from "./source.ts";
import { AgentSourceRegistryFrom } from "./registry.ts";
import { scopeAgent, readAllAgents } from "./config.ts";
import { reconcileAgents } from "./reconcile.ts";

const FS = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

/** Mock SurrealClient that records the SQL it sees and replays fixtures. */
interface QueryRecorder {
    calls: string[];
}
const recordingDb = (recorder: QueryRecorder, fixtures: ReadonlyArray<unknown[]>) => {
    let i = 0;
    return Layer.succeed(SurrealClient, {
        query: <T>(sql: string) =>
            Effect.sync(() => {
                recorder.calls.push(sql);
                return [fixtures[i++] ?? []] as unknown as T;
            }),
        upsert: () => Effect.succeed(undefined),
        relate: () => Effect.succeed(undefined),
        putFile: () => Effect.void,
    } as never);
};

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
        expect(reviewer.description).toBe("reviews code");
        expect(reviewer.model).toBe("opus");
        expect(reviewer.skills).toEqual(["commit", "tdd"]); // sorted+deduped
        expect(reviewer.contentHash.length).toBe(16);
        // No-frontmatter file still yields a record keyed by filename stem.
        expect(byName.has("plain")).toBe(true);
        expect(byName.get("plain")!.skills).toEqual([]);
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
                Effect.provide(FS),
                Effect.provide(reg()),
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
                Effect.provide(FS),
                Effect.provide(reg()),
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
                Effect.provide(FS),
                Effect.provide(reg()),
            ) as Effect.Effect<{ ok: true } | { ok: false; tag: string }, never, never>,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.tag).toBe("AgentNotFoundError");
    });
});

describe("reconcileAgents (mock SurrealClient)", () => {
    test("discovers on-disk names then issues tombstone/resurrect/touch updates", async () => {
        writeAgent("reviewer", "---\nname: reviewer\nskills:\n  - tdd\n---\nbody");
        writeAgent("planner", "---\nname: planner\n---\nbody");
        const rec: QueryRecorder = { calls: [] };

        // 2 on-disk agents; query order = SELECT absent, SELECT live, UPDATE x3.
        // would=0 (fixture[2]) keeps the safety guard from tripping.
        const report = await Effect.runPromise(
            reconcileAgents().pipe(
                Effect.provide(recordingDb(rec, [[], [1, 2], [], [], [1, 2]])),
                Effect.provide(FS),
                Effect.provide(reg()),
            ) as Effect.Effect<any, never, never>,
        );

        expect((report as { table: string }).table).toBe("agent_def");
        // reconcileTable issues the three non-dry-run UPDATEs (after two pre-SELECTs).
        const joined = rec.calls.join("\n");
        expect(joined).toContain("UPDATE agent_def SET deleted_at = time::now() WHERE name NOT IN $names");
        expect(joined).toContain("UPDATE agent_def SET deleted_at = NONE");
        expect(joined).toContain("UPDATE agent_def SET last_seen_at = time::now() WHERE name IN $names");
        expect(rec.calls.length).toBe(5);
    });

    test("dry-run issues SELECTs only, no UPDATEs", async () => {
        writeAgent("reviewer", "---\nname: reviewer\n---\nbody");
        const rec: QueryRecorder = { calls: [] };
        await Effect.runPromise(
            reconcileAgents({ dryRun: true }).pipe(
                Effect.provide(recordingDb(rec, [[], [], []])),
                Effect.provide(FS),
                Effect.provide(reg()),
            ) as Effect.Effect<any, never, never>,
        );
        expect(rec.calls.every((c) => c.startsWith("SELECT"))).toBe(true);
    });
});

describe("readAllAgents", () => {
    test("annotates on-disk agents with graph lifecycle status", async () => {
        writeAgent("reviewer", "---\nname: reviewer\nskills:\n  - tdd\n---\nbody");
        writeAgent("planner", "---\nname: planner\n---\nbody");
        const rec: QueryRecorder = { calls: [] };
        // First query is the SELECT name, deleted_at FROM agent_def.
        const graphRows = [
            { name: "reviewer", deleted_at: null },
            { name: "stale", deleted_at: "2026-01-01T00:00:00Z" },
        ];

        const rows = await Effect.runPromise(
            readAllAgents({ includeDeleted: true }).pipe(
                Effect.provide(recordingDb(rec, [graphRows])),
                Effect.provide(FS),
                Effect.provide(reg()),
            ) as Effect.Effect<any, never, never>,
        );

        const list = rows as { name: string; status: string }[];
        const byName = new Map(list.map((r) => [r.name, r.status]));
        expect(byName.get("reviewer")).toBe("live"); // on disk + live in graph
        expect(byName.get("planner")).toBe("uningested"); // on disk, not yet in graph
        expect(byName.get("stale")).toBe("deleted"); // tombstoned, gone from disk
    });
});
