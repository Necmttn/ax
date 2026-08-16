import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { buildFileContextPack } from "./file-context-pack.ts";

/**
 * `buildFileContextPack` composes seven joins across file-evidence.ts (files,
 * read_file/searched_file, touched, mentioned_file, edited+session-aggregate,
 * produced+delivery_outcome+session_health, touched-neighbor). The old
 * testing/surreal.ts fake answered each by matching SQL TEXT, which is not
 * evidence any of those joins are correct - only that the row-shaping code
 * downstream works on canned data. This is a REAL published DuckDB snapshot,
 * so a wrong JOIN (wrong column, wrong direction, missing subagent filter)
 * fails here the same way it would against production.
 */
const { dylibPath, dtest, tempDir } = await duckdbTestSetup("file-context-pack (duckdb)", { requireFts: true });

const T = (iso: string): Date => new Date(iso);

const CORPUS = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.put("session", {
            id: "session:s1",
            source: "codex",
            project: "ax",
            cwd: "/repo",
            started_at: T("2026-05-10T00:00:00.000Z"),
            ended_at: T("2026-05-10T00:20:00.000Z"),
        });
        // Decoy subagent session - every join below must filter it out.
        yield* w.put("session", {
            id: "session:s2",
            source: "claude-subagent",
            project: "ax",
            cwd: "/repo",
        });

        yield* w.putMany("file", [
            { id: "file:a", path: "src/ingest/codex.ts", repo: "ax", repository: "repository:ax" },
            { id: "file:b", path: "schema/schema.surql", repo: "ax", repository: "repository:ax" },
        ]);

        yield* w.putMany("turn", [
            {
                id: "turn:t1", session: "session:s1", seq: 1, ts: T("2026-05-10T00:00:10.000Z"),
                role: "user", message_kind: "task", intent_kind: "organic_task",
                text: "please look at src/ingest/codex.ts ingest bug",
                text_excerpt: "please look at src/ingest/codex.ts ingest bug",
                has_tool_use: false, has_error: false,
            },
            {
                id: "turn:t2", session: "session:s1", seq: 2, ts: T("2026-05-10T00:01:00.000Z"),
                role: "user", message_kind: "task", intent_kind: "preference",
                text: "use uv for python deps in codex ingest",
                text_excerpt: "use uv for python deps in codex ingest",
                has_tool_use: true, has_error: false,
            },
            {
                id: "turn:t3", session: "session:s1", seq: 3, ts: T("2026-05-10T00:01:30.000Z"),
                role: "assistant", message_kind: "assistant", intent_kind: null,
                text: "done", text_excerpt: "done",
                has_tool_use: false, has_error: false,
            },
            // Decoy: same file, but under the subagent session.
            {
                id: "turn:t4", session: "session:s2", seq: 1, ts: T("2026-05-10T00:02:00.000Z"),
                role: "user", message_kind: "task", intent_kind: "organic_task",
                text: "subagent note", text_excerpt: "subagent note",
                has_tool_use: false, has_error: false,
            },
        ]);

        yield* w.put("tool_call", {
            id: "tool_call:tc1", session: "session:s1", turn: "turn:t2",
            name: "Read", ts: T("2026-05-10T00:01:05.000Z"), command_norm: null, has_error: false,
        });
        yield* w.put("read_file", {
            id: "read_file:r1", in_id: "tool_call:tc1", out_id: "file:a",
            evidence: "tool_name", path_seen: "src/ingest/codex.ts", ts: T("2026-05-10T00:01:05.000Z"),
        });

        yield* w.putMany("edited", [
            { id: "edited:e1", in_id: "turn:t1", out_id: "file:a", tool: "Edit", ts: T("2026-05-10T00:00:15.000Z") },
            { id: "edited:e2", in_id: "turn:t2", out_id: "file:a", tool: "Edit", ts: T("2026-05-10T00:01:10.000Z") },
            // Decoy: subagent edit of the same file - must not count toward weight.
            { id: "edited:e3", in_id: "turn:t4", out_id: "file:a", tool: "Edit", ts: T("2026-05-10T00:02:05.000Z") },
        ]);

        yield* w.put("mentioned_file", {
            id: "mentioned_file:mf1", in_id: "turn:t2", out_id: "file:a",
            source: "text", ts: T("2026-05-10T00:01:00.000Z"),
        });

        yield* w.put("commit", {
            id: "commit:c1", sha: "abc1234567890", repo: "ax", message: "fix codex ingest",
            author: "neco", ts: T("2026-05-10T00:03:00.000Z"),
        });
        yield* w.putMany("touched", [
            { id: "touched:t1", in_id: "commit:c1", out_id: "file:a", additions: 5, deletions: 1, ts: T("2026-05-10T00:03:00.000Z") },
            // Same commit, a different file - the neighbor loadNeighborFiles should surface.
            { id: "touched:t2", in_id: "commit:c1", out_id: "file:b", additions: 1, deletions: 0, ts: T("2026-05-10T00:03:00.000Z") },
        ]);
        yield* w.put("produced", { id: "produced:p1", in_id: "session:s1", out_id: "commit:c1", ts: T("2026-05-10T00:03:00.000Z") });

        yield* w.put("pull_request", {
            id: "pull_request:pr1", repository: "repository:ax", provider: "github", number: 42,
            title: "Fix codex ingest bug", state: "merged",
        });
        yield* w.put("delivery_outcome", {
            id: "delivery_outcome:d1", session: "session:s1", status: "merged_to_main",
            promotion_path: "direct", review_pain: "low", pr_size: "small",
            pull_request: "pull_request:pr1", confidence: "medium",
        });
        yield* w.put("session_health", {
            id: "session_health:sh1", session: "session:s1", source: "codex", interruptions: 1,
        });
    });

describe("file context pack (DuckDB)", () => {
    dtest("builds a compact pack with ranked user context and deduped evidence", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-file-context-pack-"), dylibPath, CORPUS));

        const pack = await readThroughFixture(
            fixture,
            dylibPath,
            buildFileContextPack({
                q: "fix the codex ingest bug in src/ingest/codex.ts",
                files: ["src/ingest/codex.ts"],
            }),
        );

        // Only the file actually named resolves - schema/schema.surql was
        // never mentioned in q or files.
        expect(pack.files.map((file) => file.path)).toEqual(["src/ingest/codex.ts"]);

        // Tool evidence: one read_file row, path taken from the JOIN (not a
        // leaked file:a record id) - the exact regression the old test named.
        expect(pack.evidence.tool_file).toHaveLength(1);
        expect(pack.evidence.tool_file[0]).toMatchObject({
            kind: "read_file",
            path: "src/ingest/codex.ts",
            tool_name: "Read",
        });

        // Mentions: turn:t2 (preference, mentioned_file) is scored and kept;
        // the subagent turn never entered a mentioned_file edge at all.
        expect(pack.evidence.mention_turns.map((t) => t.id)).toEqual(["turn:t2"]);
        expect(pack.evidence.mention_turns[0]?.why).toEqual(["codex: src/ingest/codex.ts"]);

        // Prior file sessions: weight = 2 (turn:t1 + turn:t2 edits), NOT 3 -
        // the subagent decoy edit (turn:t4) must be filtered by the join.
        expect(pack.evidence.prior_file_sessions).toHaveLength(1);
        expect(pack.evidence.prior_file_sessions[0]).toMatchObject({
            session: "session:s1",
            title: "Fix codex ingest bug",
            weight: 2,
            files_touched: 1,
            top_files: ["src/ingest/codex.ts"],
            produced_commits: 1,
            delivery_status: "merged_to_main",
            review_pain: "low",
            pr_size: "small",
            pr_title: "Fix codex ingest bug",
            merged_to_main: true,
            user_turns: 2,
            assistant_turns: 1,
            corrections: 0,
            interruptions: 1,
        });

        // Produced-session turns: both real user turns from session:s1,
        // ordered earliest first.
        expect(pack.evidence.produced_session_turns.map((t) => t.id)).toEqual(["turn:t1", "turn:t2"]);

        // Neighbor files: touched:t2 (schema.surql) rode the same commit as
        // the target file and is not itself a target - surfaces as a neighbor.
        expect(pack.evidence.neighbor_files).toEqual([{ path: "schema/schema.surql", count: 1 }]);

        expect(pack.ai_context).toContain("Prior sessions that edited these files:");
        expect(pack.ai_context).toContain("2 edits, 1 files, 1 commits, 2u/1a");
        expect(pack.ai_context).toContain("Neighbor files often changed with these files:");
        expect(pack.ai_context).toContain("schema/schema.surql (1)");
        expect(pack.ai_context.match(/abc1234567/g)?.length).toBe(1);

        expect(pack.graph_inspection_query).toContain("FROM file WHERE id IN ('file:a')");
    }, 60_000);
});
