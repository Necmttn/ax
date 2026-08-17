/**
 * `ax sessions show`, END TO END, with no server of any kind running.
 *
 * This is the acceptance test for wave 3 chunk 2a (`c-read-seam`), and it has
 * to be out-of-process for the same reason `recall-daemonless.test.ts` does: an
 * in-process test is HANDED its layers, so it passes whether or not the real
 * CLI would have built `AppLayer` and tried to connect. The child gets
 *
 *   - `AX_DUCKDB_SNAPSHOT` pointing at a snapshot this suite published, and
 *   - `AX_DB_URL` on a port nothing is listening on, so any SurrealDB connect
 *     fails rather than quietly finding the developer's own running daemon and
 *     making the test pass for the wrong reason.
 *
 * One invocation exercises the whole ported chain:
 * `queries/session-detail-cache.ts` -> `dashboard/session-detail.ts` ->
 * `dashboard/session-view.ts` -> `queries/enriched-session.ts`, plus
 * `metrics/reverted-commits.ts` and the prefix fallback in
 * `dashboard/sessions-query.ts`.
 *
 * WHY THE ASSERTIONS ARE ON POPULATED FIELDS. Before this chunk the same
 * command exited 0 and printed a well-formed envelope full of empty lists,
 * because `queryMany`/`queryOptional` catch `DbError` and degrade - and a
 * successful query against a write-frozen engine never even trips that catch.
 * "Exit code 0" and "valid JSON" are therefore NOT evidence of anything here;
 * only the row CONTENT is.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("ax sessions show (no surreal)", {
    requireFts: true,
});

/** The CLI entrypoint, run the way `bin/axctl` runs it. */
const CLI = new URL("./index.ts", import.meta.url).pathname;

/** A port nothing listens on, so a SurrealDB connect can only FAIL. */
const DEAD_DB_URL = "ws://127.0.0.1:1/rpc";

const PARENT = "019e0ad4-1111-2222-3333-444444444444";
const CHILD = "claude-subagent-a41ef01d6ca8d521c";

const T = (iso: string): Date => new Date(iso);

const CORPUS = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            {
                id: PARENT,
                source: "claude",
                project: "ax",
                cwd: "/w/ax",
                model: "claude-opus-5",
                started_at: T("2026-08-10T10:00:00.000Z"),
                ended_at: T("2026-08-10T11:00:00.000Z"),
            },
            {
                id: CHILD,
                source: "claude-subagent",
                project: "ax",
                cwd: "/w/ax",
                model: "claude-sonnet-5",
                started_at: T("2026-08-10T10:20:00.000Z"),
                ended_at: T("2026-08-10T10:40:00.000Z"),
            },
        ]);
        yield* w.putMany("turn", [
            {
                id: "turn-1",
                session: PARENT,
                seq: 1,
                ts: T("2026-08-10T10:00:01.000Z"),
                role: "user",
                message_kind: "task",
                intent_kind: "organic_task",
                text: "port the read seam onto duckdb",
                text_excerpt: "port the read seam onto duckdb",
                has_tool_use: false,
                has_error: false,
            },
            {
                id: "turn-2",
                session: PARENT,
                seq: 2,
                ts: T("2026-08-10T10:00:02.000Z"),
                role: "assistant",
                message_kind: "assistant",
                intent_kind: "response",
                text: "reading the seam now",
                text_excerpt: "reading the seam now",
                has_tool_use: true,
                has_error: false,
            },
        ]);
        yield* w.put("skill", {
            id: "skill-tdd",
            name: "tdd",
            scope: "user",
            dir_path: "/skills/tdd",
            content_hash: "h1",
        });
        yield* w.putMany(
            "invoked",
            [0, 1, 2].map((i) => ({
                id: `inv-${i}`,
                in_id: "turn-1",
                out_id: "skill-tdd",
                session: PARENT,
                ts: T("2026-08-10T10:00:05.000Z"),
            })),
        );
        yield* w.putMany("tool_call", [
            {
                id: "call-bash-ok",
                session: PARENT,
                name: "Bash",
                ts: T("2026-08-10T10:05:00.000Z"),
                command_norm: "bun test",
                input_json: '{"command":"bun test"}',
                has_error: false,
            },
            {
                id: "call-bash-bad",
                session: PARENT,
                name: "Bash",
                ts: T("2026-08-10T10:06:00.000Z"),
                command_norm: "bun test",
                input_json: '{"command":"bun test"}',
                has_error: true,
            },
        ]);
        yield* w.put("tool_call", {
            id: "call-agent",
            session: PARENT,
            name: "Agent",
            ts: T("2026-08-10T10:20:00.000Z"),
            input_json: JSON.stringify({
                subagent_type: "general-purpose",
                description: "review the seam",
                prompt: "read every reader and report",
            }),
            output_excerpt: "reviewed",
            has_error: false,
        });
        yield* w.put("spawned", {
            id: "spawn-1",
            in_id: PARENT,
            out_id: CHILD,
            ts: T("2026-08-10T10:20:00.000Z"),
            tool: "Agent",
            nickname: "worker",
        });
        yield* w.put("session_token_usage", {
            id: "stu-1",
            session: PARENT,
            source: "claude",
            model: "claude-opus-5",
            prompt_tokens: 1200,
            completion_tokens: 340,
            estimated_tokens: 1540,
            transcript_bytes: 4096,
            estimated_cost_usd: 0.42,
            pricing_source: "catalog",
            ts: T("2026-08-10T11:00:00.000Z"),
        });
        yield* w.put("compaction", {
            id: "compact-1",
            session: PARENT,
            harness: "claude",
            ts: T("2026-08-10T10:30:00.000Z"),
            strategy: "summarize",
            source_confidence: "explicit",
            trigger: "auto",
            tokens_before: 150_000,
            kept_count: 12,
            summary: "kept the seam work, dropped the exploration",
        });
    });

interface CliRun {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

const runCli = (args: ReadonlyArray<string>, snapshotPath: string): CliRun => {
    const child = Bun.spawnSync(["bun", CLI, ...args], {
        env: {
            ...process.env,
            AX_DUCKDB_SNAPSHOT: snapshotPath,
            AX_DB_URL: DEAD_DB_URL,
            ...(dylibPath === null ? {} : { AX_DUCKDB_DYLIB: dylibPath }),
            AX_PROGRESS: "off",
            NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        exitCode: child.exitCode,
        stdout: child.stdout.toString(),
        stderr: child.stderr.toString(),
    };
};

/** `renderSessionJson` SPREADS `payload.session` at the top level (and does not
 *  carry `compactions` - that field is asserted in session-view.test.ts). */
interface ShowPayload {
    readonly overview: { readonly id: string; readonly project: string | null } | null;
    readonly top_skills: ReadonlyArray<{ skill: string; count: number; last_used: string | null }>;
    readonly tool_calls: ReadonlyArray<{ label: string; count: number; failures: number }>;
    readonly children: ReadonlyArray<{ session_id: string; nickname: string | null }>;
    readonly agent_delegations: ReadonlyArray<{ description: string | null; phase: string }>;
    readonly token_usage: { estimated_cost_usd: number | null } | null;
    readonly expanded_subagents: ReadonlyArray<unknown>;
    readonly turns?: ReadonlyArray<{ seq: number; role: string }>;
}

describe("ax sessions show on the cache runtime", () => {
    dtest("returns a POPULATED payload with no SurrealDB reachable", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-sessions-show-nodb-"), dylibPath, CORPUS),
        );

        const run = runCli(["sessions", "show", PARENT, "--turns", "--json"], fixture.snapshotPath);

        // The throwing no-DB proxy names `SurrealClient.<prop>` when a ported
        // path still reaches for the old engine.
        expect(run.stderr).not.toContain("SurrealClient");
        if (run.exitCode !== 0) throw new Error(`exit ${run.exitCode}\n${run.stderr}`);

        const body = JSON.parse(run.stdout) as ShowPayload;

        expect(body.overview?.id).toBe(PARENT);
        expect(body.overview?.project).toBe("ax");
        expect(body.top_skills).toEqual([
            { skill: "tdd", count: 3, last_used: "2026-08-10T10:00:05.000Z" },
        ]);
        expect(body.tool_calls).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ label: "bun test", count: 2, failures: 1 }),
            ]),
        );
        expect(body.children.map((c) => c.session_id)).toEqual([CHILD]);
        expect(body.children[0]?.nickname).toBe("worker");
        expect(body.agent_delegations).toEqual([
            expect.objectContaining({ description: "review the seam", phase: "review" }),
        ]);
        expect(body.token_usage?.estimated_cost_usd).toBe(0.42);
        expect(body.turns?.map((t) => [t.seq, t.role])).toEqual([
            [1, "user"],
            [2, "assistant"],
        ]);
    }, 60_000);

    dtest("resolves a session-id PREFIX through the cache", async () => {
        // The fallback path: `overview === null` on the first probe sends the
        // command through `findSessionIdsByPrefix`, which was SurrealQL.
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-sessions-show-prefix-"), dylibPath, CORPUS),
        );

        const run = runCli(["sessions", "show", PARENT.slice(0, 8), "--json"], fixture.snapshotPath);

        expect(run.stderr).not.toContain("SurrealClient");
        expect(run.stderr).toContain(`resolved id prefix ${PARENT.slice(0, 8)}`);
        if (run.exitCode !== 0) throw new Error(`exit ${run.exitCode}\n${run.stderr}`);
        const body = JSON.parse(run.stdout) as ShowPayload;
        expect(body.overview?.id).toBe(PARENT);
    }, 60_000);

    dtest("a session the snapshot does not hold is a clean not-found, not an empty payload", async () => {
        // The control that makes the case above meaningful: if the reader were
        // still answering [] for everything, THIS is the output the first case
        // would have produced, so the two have to be distinguishable.
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-sessions-show-miss-"), dylibPath, CORPUS),
        );

        const run = runCli(
            ["sessions", "show", "019e0ad4-9999-9999-9999-999999999999", "--json"],
            fixture.snapshotPath,
        );

        expect(run.stderr).not.toContain("SurrealClient");
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("not found");
    }, 60_000);
});
