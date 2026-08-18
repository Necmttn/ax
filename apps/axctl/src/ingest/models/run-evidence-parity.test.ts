/**
 * The Phase 3 shadow contract (#888): the SQL models must produce the SAME
 * ledger as the TS builders, row-for-row on the natural key
 * (session, source_table, source_id) - over a fixture that exercises every
 * derived kind, the lineage walk, the objective pick, the edited bridge, and
 * the check_family backfill.
 *
 * Ids and path_hash are compared by PRESENCE/SHAPE, not value: the model uses
 * md5 where TS used Bun.hash (documented rebuildable-cache freedom; the
 * version cutover wipes TS-era rows so the schemes never coexist).
 */
import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { deriveRunEvidence } from "../derive-run-evidence.ts";
import { runRunEvidenceModels } from "./run-evidence-models.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("run evidence parity", { requireFts: true });

// Recent, so a 30-day-window model run genuinely re-upserts the fixture rows
// (an old fixed date would fall outside the window and prove nothing).
const TS0 = new Date(Date.now() - 24 * 3600 * 1000);
const at = (min: number) => new Date(TS0.getTime() + min * 60_000);

/** Seed a store that exercises every branch of both implementations. */
const seedFixture = (write: CacheWriteService) =>
    Effect.gen(function* () {
        // Sessions: a top-level claude session, a codex session, and a
        // spawned chain top -> mid -> leaf for the lineage walk.
        yield* write.putMany("session", [
            { id: "top", source: "claude", started_at: at(0), checkout: "chk1" },
            { id: "mid", source: "claude", started_at: at(1), checkout: null },
            { id: "leaf", source: "claude", started_at: at(2), checkout: null },
            { id: "codex-s", source: "codex", started_at: at(0), checkout: null },
        ]);
        yield* write.put("checkout", {
            id: "chk1", repository: "repo1", path: "/tmp/repo1", branch: "main", head_sha: "abcdef1234567890",
        });
        yield* write.putMany("spawned", [
            { id: "sp1", in_id: "top", out_id: "mid", ts: at(1) },
            { id: "sp2", in_id: "mid", out_id: "leaf", ts: at(2) },
        ]);

        // Tool calls: plain, erroring, an edit pair (one single-edit turn, one
        // ambiguous double-edit turn), and the check the outcomes stamp covers.
        yield* write.putMany("tool_call", [
            { id: "tc1", session: "top", turn: "t-tool1", name: "Bash", ts: at(3), has_error: false, command_norm: "rg foo", command_text: "rg foo src/" },
            { id: "tc2", session: "codex-s", turn: "t-tool2", name: "exec_command", ts: at(4), has_error: true, command_norm: "bun test", command_text: "bun test" },
            { id: "tc-edit1", session: "top", turn: "t-edit-single", name: "Edit", ts: at(5), has_error: false, command_norm: null, command_text: null },
            { id: "tc-edit2a", session: "top", turn: "t-edit-double", name: "Edit", ts: at(6), has_error: false, command_norm: null, command_text: null },
            { id: "tc-edit2b", session: "top", turn: "t-edit-double", name: "Write", ts: at(6), has_error: false, command_norm: null, command_text: null },
            // On the spawn-chain LEAF, so its event must carry parent=mid,
            // root=top - the lineage walk is load-bearing in this fixture.
            { id: "tc-leaf", session: "leaf", turn: null, name: "Read", ts: at(4), has_error: false, command_norm: null, command_text: null },
        ]);

        // Command outcomes: a stamped check, an UNSTAMPED legacy check (the
        // backfill must classify it from tool_call.command_text), and a plain
        // success that must never become a verification.
        yield* write.putMany("command_outcome", [
            { id: "co1", session: "top", tool_call: "tc1", kind: "success", status: "ok", command_norm: "bunx tsc --noEmit", check_family: "typecheck", ts: at(7) },
            { id: "co2", session: "codex-s", tool_call: "tc2", kind: "expected_feedback", status: "error", command_norm: "bun test", check_family: null, ts: at(8) },
            { id: "co3", session: "top", tool_call: null, kind: "success", status: "ok", command_norm: "ls -la", check_family: null, ts: at(9) },
        ]);

        // Compactions: one with a summary (boundary + derived_summary), one
        // without (boundary only). tokens_before is BIGINT in the DDL.
        yield* write.putMany("compaction", [
            { id: "cmp1", session: "top", harness: "claude", ts: at(10), trigger: "auto", strategy: "summarize", source_confidence: "explicit", summary: "compacted the history", tokens_before: 123_456 },
            { id: "cmp2", session: "codex-s", harness: "codex", ts: at(11), trigger: null, strategy: "truncate", source_confidence: "explicit", summary: null, tokens_before: null },
        ]);

        yield* write.put("plan_snapshot", { id: "ps1", session: "top", ts: at(12), summary: "3 todos, 1 in progress", source: "claude_task", items: "[]" });

        // Task turns: two per session; only the EARLIEST (min seq) is the
        // objective. A non-task turn must not qualify.
        yield* write.putMany("turn", [
            { id: "t-obj1", session: "top", seq: 2, role: "user", message_kind: "task", ts: at(2), text_excerpt: "fix the flaky test" },
            { id: "t-obj2", session: "top", seq: 5, role: "user", message_kind: "task", ts: at(3), text_excerpt: "second ask" },
            { id: "t-ctx", session: "top", seq: 1, role: "user", message_kind: "context", ts: at(1), text_excerpt: "system noise" },
            { id: "t-obj-codex", session: "codex-s", seq: 1, role: "user", message_kind: "task", ts: at(1), text_excerpt: "port the parser" },
            { id: "t-edit-single", session: "top", seq: 7, role: "assistant", message_kind: "work", ts: at(5), text_excerpt: null },
            { id: "t-edit-double", session: "top", seq: 8, role: "assistant", message_kind: "work", ts: at(6), text_excerpt: null },
            { id: "t-tool1", session: "top", seq: 6, role: "assistant", message_kind: "work", ts: at(3), text_excerpt: null },
            { id: "t-tool2", session: "codex-s", seq: 2, role: "assistant", message_kind: "work", ts: at(4), text_excerpt: null },
        ]);

        // Hook invocations: one real intervention, one pass-through (excluded).
        yield* write.putMany("hook_command_invocation", [
            { id: "h1", session: "top", tool_call: "tc1", hook_event: "harness-hook-1", ts: at(13), harness: "claude", event_name: "PreToolUse", hook_name: "enforce-worktree", command: "bun dispatch.ts", command_hash: "hash1", effect: "blocked", provider_status: "success" },
            { id: "h2", session: "top", tool_call: null, hook_event: "harness-hook-2", ts: at(14), harness: "claude", event_name: "PreToolUse", hook_name: "quiet-hook", command: "bun dispatch.ts", command_hash: "hash2", effect: "none", provider_status: "success" },
        ]);

        // File evidence edges + the edited bridge (single-edit anchors,
        // double-edit is dropped).
        yield* write.putMany("file", [
            { id: "f1", path: "src/a.ts" },
            { id: "f2", path: "src/b.ts" },
        ]);
        yield* write.put("read_file", { id: "rf1", in_id: "tc1", out_id: "f1", ts: at(3), path_seen: "src/a.ts" });
        yield* write.put("searched_file", { id: "sf1", in_id: "tc1", out_id: "f2", ts: at(3), path_seen: "src/b.ts" });
        yield* write.putMany("edited", [
            { id: "ed1", in_id: "t-edit-single", out_id: "f1", ts: at(5), path_seen: "src/a.ts", tool: "Edit" },
            { id: "ed2", in_id: "t-edit-double", out_id: "f2", ts: at(6), path_seen: "src/b.ts", tool: "Edit" },
        ]);
    });

interface EventSnap {
    readonly kind: string;
    readonly backing: string;
    readonly provider: string;
    readonly root: string | null;
    readonly parent: string | null;
    readonly ts: string;
    readonly links: Record<string, string | null>;
    readonly summary: string | null;
    readonly attrs: unknown;
}

const snapshotEvents = (write: CacheWriteService) =>
    Effect.gen(function* () {
        const rows = yield* write.rows(
            Schema.Struct({
                session: Schema.String, source_table: Schema.String, source_id: Schema.String,
                kind: Schema.String, backing: Schema.String, provider: Schema.String,
                root_session: Schema.NullOr(Schema.String), parent_session: Schema.NullOr(Schema.String),
                ts: Schema.String, turn: Schema.NullOr(Schema.String), tool_call: Schema.NullOr(Schema.String),
                compaction: Schema.NullOr(Schema.String), plan_snapshot: Schema.NullOr(Schema.String),
                command_outcome: Schema.NullOr(Schema.String), hook_invocation: Schema.NullOr(Schema.String),
                checkout: Schema.NullOr(Schema.String), summary: Schema.NullOr(Schema.String),
                attrs: Schema.NullOr(Schema.String),
            }),
            `SELECT session, source_table, source_id, kind, backing, provider, root_session, parent_session,
                    CAST(ts AS VARCHAR) AS ts, turn, tool_call, compaction, plan_snapshot, command_outcome,
                    hook_invocation, checkout, summary, attrs
             FROM run_evidence_event`,
        );
        const map = new Map<string, EventSnap>();
        for (const r of rows) {
            map.set(`${r.session}|${r.source_table}|${r.source_id}`, {
                kind: r.kind, backing: r.backing, provider: r.provider,
                root: r.root_session, parent: r.parent_session, ts: r.ts,
                links: {
                    turn: r.turn, tool_call: r.tool_call, compaction: r.compaction,
                    plan_snapshot: r.plan_snapshot, command_outcome: r.command_outcome,
                    hook_invocation: r.hook_invocation, checkout: r.checkout,
                },
                summary: r.summary,
                attrs: r.attrs === null ? null : JSON.parse(r.attrs),
            });
        }
        return map;
    });

const snapshotRefs = (write: CacheWriteService) =>
    Effect.gen(function* () {
        const rows = yield* write.rows(
            Schema.Struct({
                session: Schema.String, source_table: Schema.String, source_id: Schema.String,
                ref_kind: Schema.String, target_table: Schema.NullOr(Schema.String),
                target_id: Schema.NullOr(Schema.String), has_path_hash: Schema.Boolean,
                privacy_level: Schema.String, attrs: Schema.NullOr(Schema.String),
            }),
            `SELECT e.session, e.source_table, e.source_id, r.ref_kind, r.target_table, r.target_id,
                    r.path_hash IS NOT NULL AS has_path_hash, r.privacy_level, r.attrs
             FROM run_evidence_ref r JOIN run_evidence_event e ON e.id = r."event"`,
        );
        return new Set(rows.map((r) => JSON.stringify({
            event: `${r.session}|${r.source_table}|${r.source_id}`,
            refKind: r.ref_kind, targetTable: r.target_table, targetId: r.target_id,
            hasPathHash: r.has_path_hash, privacy: r.privacy_level,
            attrs: r.attrs === null ? null : JSON.parse(r.attrs),
        })));
    });

describe("run-evidence SQL model parity vs the TS builders", () => {
    dtest("row-for-row equal on the natural key, refs included", async () => {
        let tsEvents!: Map<string, EventSnap>;
        let sqlEvents!: Map<string, EventSnap>;
        let tsRefs!: Set<string>;
        let sqlRefs!: Set<string>;
        let modelStats: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-rev-parity-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* seedFixture(write);

                // Pass 1: the TS shadow implementation.
                yield* deriveRunEvidence(write, undefined);
                tsEvents = yield* snapshotEvents(write);
                tsRefs = yield* snapshotRefs(write);

                // Pass 2: the SQL models, via the version cutover (fresh store
                // has no marker -> backfills check_family, wipes, full-derives).
                modelStats = yield* runRunEvidenceModels(write, undefined);
                sqlEvents = yield* snapshotEvents(write);
                sqlRefs = yield* snapshotRefs(write);
            }),
        ));

        // The cutover ran: co2 was unstamped and needed the backfill.
        expect(modelStats).toMatchObject({ rebuilt: true });
        expect((modelStats as { backfilled: number }).backfilled).toBeGreaterThanOrEqual(1);

        // Same natural-key set.
        const tsKeys = [...tsEvents.keys()].sort();
        const sqlKeys = [...sqlEvents.keys()].sort();
        expect(sqlKeys).toEqual(tsKeys);

        // Same row content per key.
        for (const key of tsKeys) {
            expect({ key, ...sqlEvents.get(key)! }).toEqual({ key, ...tsEvents.get(key)! });
        }

        // Refs: same set on (event natural key, kind, target, attrs).
        expect([...sqlRefs].sort()).toEqual([...tsRefs].sort());

        // Sanity on coverage: every derived kind is present in the fixture run.
        const kinds = new Set([...tsEvents.values()].map((e) => e.kind));
        expect([...kinds].sort()).toEqual([
            "boundary", "derived_summary", "objective", "policy_decision",
            "repo_state", "task_state", "tool_observation", "verification",
        ]);
        // The double-edit turn's ref was dropped; the single-edit anchored.
        const editRefs = [...tsRefs].filter((r) => (JSON.parse(r).attrs as { access?: string })?.access === "write");
        expect(editRefs).toHaveLength(1);
    });

    dtest("second model run is windowed (no cutover) and idempotent", async () => {
        let first: unknown;
        let second: unknown;
        let countAfter = -1;
        await runWithPlatform(publishCacheFixture(tempDir("ax-rev-idem-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* seedFixture(write);
                first = yield* runRunEvidenceModels(write, undefined);
                const eventsAfterFirst = yield* write.rows(
                    Schema.Struct({ n: Schema.Number }),
                    "SELECT count(*)::INTEGER AS n FROM run_evidence_event",
                );
                second = yield* runRunEvidenceModels(write, 30);
                const eventsAfterSecond = yield* write.rows(
                    Schema.Struct({ n: Schema.Number }),
                    "SELECT count(*)::INTEGER AS n FROM run_evidence_event",
                );
                expect(eventsAfterSecond[0]!.n).toBe(eventsAfterFirst[0]!.n);
                countAfter = eventsAfterSecond[0]!.n;
            }),
        ));
        expect(first).toMatchObject({ rebuilt: true });
        expect(second).toMatchObject({ rebuilt: false });
        expect(countAfter).toBeGreaterThan(0);
    });
});
