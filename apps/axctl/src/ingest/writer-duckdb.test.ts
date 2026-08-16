import { expect, describe } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { SkillName } from "@ax/lib/brands";
import { skillRowId } from "@ax/lib/stable-id";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { writeNormalizedTranscriptBatch, type NormalizedTranscriptBatch } from "./normalized/transcripts.ts";
import { OtelWriter, OtelWriterLive } from "../otel/writer.ts";
import { buildSessionCheckoutWhere } from "./git.ts";
import { withIngestRunFinish } from "./run.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("ingest DuckDB writers", {
    requireFts: true,
});

const at = new Date("2026-08-15T00:00:00.000Z");

const emptyBatch = (): NormalizedTranscriptBatch => ({
    providers: [],
    sessions: [],
    events: [],
    turns: [],
    toolCalls: [],
    toolFileEvidence: [],
    agentEventParentEdges: [],
    syntheticSkillInvocations: [],
    toolCallSkillRelations: [],
    planSnapshots: [],
    compactions: [],
});

describe("git session query binding", () => {
    dtest("keeps repository paths out of SQL text", () => {
        const clause = buildSessionCheckoutWhere("/repo/it's-main", ["/repo/it's-main/worktree"]);
        expect(clause.sql).not.toContain("'");
        expect(clause.sql).not.toContain("/repo");
        expect(clause.params).toEqual([
            "/repo/it's-main",
            "/repo/it's-main/%",
            "/repo/it's-main/worktree",
            "/repo/it's-main/worktree/%",
        ]);
    });
});

describe("real DuckDB ingest writers", () => {
    dtest("normalized writes replace provider events and preserve catalog skills", async () => {
        let result: Record<string, unknown> = {};
        await runWithPlatform(publishCacheFixture(tempDir("ax-writer-normalized-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("skill", {
                    id: skillRowId("kubuntu"),
                    name: "kubuntu",
                    scope: "user",
                    dir_path: "/skills/kubuntu",
                    content_hash: "real",
                });

                const initial = emptyBatch();
                yield* writeNormalizedTranscriptBatch(write, {
                    ...initial,
                    providers: [{ name: "pi", displayName: "Pi" }],
                    sessions: [{ id: "session-1", provider: "pi", startedAt: at }],
                    events: [{
                        provider: "pi", providerSessionId: "session-1", providerEventId: "stale",
                        seq: 1, ts: at, type: "message",
                    }],
                });

                yield* writeNormalizedTranscriptBatch(write, {
                    ...emptyBatch(),
                    providers: [{ name: "pi", displayName: "Pi" }],
                    sessions: [{ id: "session-1", provider: "pi", startedAt: at }],
                    events: [
                        { provider: "pi", providerSessionId: "session-1", providerEventId: "parent", seq: 1, ts: at, type: "message" },
                        { provider: "pi", providerSessionId: "session-1", providerEventId: "child", parentProviderEventId: "parent", seq: 2, ts: at, type: "message" },
                    ],
                    turns: [{
                        sessionId: "session-1", seq: 1, ts: at, role: "assistant",
                        messageKind: "assistant", intentKind: "assistant", text: "done",
                        textExcerpt: "done", hasToolUse: false, hasError: false,
                    }],
                    syntheticSkillInvocations: [
                        { sessionId: "session-1", seq: 1, ts: at, skillName: SkillName.make("kubuntu"), skillUpsert: "if_missing" },
                        { sessionId: "session-1", seq: 1, ts: at, skillName: SkillName.make("pi:bash"), skillScope: "pi-tool" },
                    ],
                });

                const countRow = yield* write.rows(Schema.Struct({ events: Schema.BigInt, edges: Schema.BigInt, invoked: Schema.BigInt }), `
SELECT
  (SELECT count(*) FROM agent_event) AS events,
  (SELECT count(*) FROM agent_event_child) AS edges,
  (SELECT count(*) FROM invoked) AS invoked`);
                const catalogRows = yield* write.rows(
                    Schema.Struct({ scope: Schema.String, dir_path: Schema.String, content_hash: Schema.String }),
                    "SELECT scope, dir_path, content_hash FROM skill WHERE name = 'kubuntu'",
                );
                result = { counts: countRow[0], catalog: catalogRows[0] };
            }),
        ));

        expect(result.counts).toEqual({ events: 2n, edges: 1n, invoked: 2n });
        expect(result.catalog).toEqual({ scope: "user", dir_path: "/skills/kubuntu", content_hash: "real" });
    });

    dtest("plan reconciliation removes an older item with the same external id", async () => {
        let rows: ReadonlyArray<{ readonly id: string }> = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-writer-plan-delete-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("session", { id: "session-plan", source: "claude", started_at: at });
                const batch = emptyBatch();
                const plan = (itemKey: string): NormalizedTranscriptBatch => ({
                    ...batch,
                    planSnapshots: [{
                        planKey: "plan-1", sessionId: "session-plan", source: "claude_task",
                        status: "active", createdAt: at, snapshotKey: `snapshot-${itemKey}`,
                        itemsJson: [{ id: "task-1" }], ts: at,
                        items: [{ key: itemKey, externalId: "task-1", seq: 1, content: itemKey }],
                    }],
                });
                yield* writeNormalizedTranscriptBatch(write, plan("old-item"), { clearExisting: false });
                yield* writeNormalizedTranscriptBatch(write, plan("new-item"), { clearExisting: false });
                rows = yield* write.rows(Schema.Struct({ id: Schema.String }), "SELECT id FROM plan_item ORDER BY id");
            }),
        ));
        expect(rows).toEqual([{ id: "new-item" }]);
    });

    dtest("OTLP writers bind metric, span, and log rows", async () => {
        let counts: ReadonlyArray<{ readonly metrics: bigint; readonly spans: bigint; readonly logs: bigint }> = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-writer-otel-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const writer = yield* OtelWriter;
                yield* writer.writeMetrics([{ harness: "claude", metric: "cost", value: 1,
                    unit: "USD", session_id: "s1", model: null, skill_name: null, agent_name: null,
                    attrs: "{}", observed_at: at }]);
                yield* writer.writeSpans([{ harness: "claude", name: "run", trace_id: "t", span_id: "s",
                    parent_span_id: null, session_id: "s1", started_at: at, ended_at: at,
                    duration_ms: 0, attrs: "{}", observed_at: at }]);
                yield* writer.writeLogs([{ harness: "codex", event_name: "token_usage", session_id: "s1",
                    model: "gpt-5", input_tokens: 1, output_tokens: 2, reasoning_tokens: 0,
                    cached_tokens: 0, tool_tokens: 0, duration_ms: null, status_code: null,
                    attrs: "{}", observed_at: at }]);
                counts = yield* write.rows(Schema.Struct({ metrics: Schema.BigInt, spans: Schema.BigInt, logs: Schema.BigInt }), `
SELECT
  (SELECT count(*) FROM otel_metric_point) AS metrics,
  (SELECT count(*) FROM otel_span) AS spans,
  (SELECT count(*) FROM otel_log_event) AS logs`);
            }).pipe(Effect.provide(OtelWriterLive(write))),
        ));
        expect(counts[0]).toEqual({ metrics: 1n, spans: 1n, logs: 1n });
    });

    dtest("ingest run finalizers settle success and failure rows", async () => {
        let rows: ReadonlyArray<Record<string, unknown>> = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-writer-run-finish-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const startedAt = new Date();
                yield* write.putMany("ingest_run", [
                    { id: "run-ok", command: "ingest", status: "running", started_at: startedAt, last_progress_at: startedAt },
                    { id: "run-error", command: "ingest", status: "running", started_at: startedAt, last_progress_at: startedAt },
                ]);
                yield* withIngestRunFinish(write, "run-ok")(Effect.succeed("done"));
                const failed = yield* Effect.exit(
                    withIngestRunFinish(write, "run-error")(Effect.fail("boom")),
                );
                expect(Exit.isFailure(failed)).toBe(true);
                rows = yield* write.rows(
                    Schema.Struct({ id: Schema.String, status: Schema.String, metrics: Schema.NullOr(Schema.String) }),
                    "SELECT id, status, metrics FROM ingest_run ORDER BY id",
                );
            }),
        ));

        expect(rows).toEqual([
            { id: "run-error", status: "error", metrics: '{"error":"boom"}' },
            { id: "run-ok", status: "ok", metrics: "{}" },
        ]);
    });
});
