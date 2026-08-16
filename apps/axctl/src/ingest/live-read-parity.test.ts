import { expect } from "bun:test";
import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { loadPricingCatalogForModels } from "../metrics/cost-estimate.ts";
import { persistFragilityCascade, readFragilityCascade } from "../metrics/fragility-cascade.ts";
import { fetchSessionChurnSummary } from "../metrics/session-churn.ts";
import { computeSessionLoc } from "../metrics/session-loc.ts";
import { fetchSessionHealthMap } from "../metrics/session-metrics-query.ts";
import { fetchMainBranchGraphEvidence, fetchObservedTooling } from "../project/harness.ts";
import { fetchDirectiveLift } from "../queries/directive-ngrams.ts";
import { fetchDispatchCandidates } from "../queries/dispatch-analytics.ts";
import { fetchImageContext } from "../queries/image-context.ts";
import { sessionTelemetryCost, sessionTelemetryLatency } from "../queries/telemetry-rollup.ts";
import { fetchWorkflowArcs } from "../queries/workflow-sequences.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("live read parity", {
    requireFts: true,
});

const NOW = "2026-08-15T00:00:00.000Z";
const RECENT = new Date();
const LATER = new Date(RECENT.getTime() + 1_000);

interface LiveResults {
    readonly costEstimate: unknown;
    readonly fragilityCascade: unknown;
    readonly sessionChurn: unknown;
    readonly sessionLoc: unknown;
    readonly sessionMetrics: unknown;
    readonly projectHarness: unknown;
    readonly directiveNgrams: unknown;
    readonly dispatchAnalytics: unknown;
    readonly imageContext: unknown;
    readonly telemetryRollup: unknown;
    readonly workflowSequences: unknown;
}

let fixturePromise: Promise<{ readonly snapshotPath: string; readonly live: LiveResults }> | undefined;

const seedCurrentRows = (write: import("@ax/lib/duckdb/seam").CacheWriteService) =>
    Effect.gen(function* () {
        yield* write.put("agent_model", {
            id: "model-live",
            name: "gpt-5",
            provider: "openai",
            display_name: "GPT-5",
            input_per_million_usd: 1.25,
            output_per_million_usd: 10,
            pricing_source: "test",
        });
        yield* write.putMany("session", [
            { id: "parent", source: "claude", model: "claude-opus-4-1", started_at: RECENT },
            { id: "child", source: "claude-subagent", model: "claude-opus-4-1", started_at: RECENT },
            { id: "workflow-2", source: "claude", model: null, started_at: RECENT },
            { id: "workflow-3", source: "claude", model: null, started_at: RECENT },
        ]);
        yield* write.putMany("turn", [
            { id: "turn-1", session: "parent", seq: 1n, ts: RECENT, role: "user", text_excerpt: "always verify tests" },
            { id: "turn-2", session: "parent", seq: 2n, ts: RECENT, role: "user", text_excerpt: "always verify tests" },
            { id: "turn-3", session: "workflow-2", seq: 1n, ts: RECENT, role: "user", text_excerpt: "always verify tests" },
            { id: "turn-4", session: "workflow-2", seq: 2n, ts: RECENT, role: "user", text_excerpt: "always verify tests" },
            { id: "turn-5", session: "workflow-3", seq: 1n, ts: RECENT, role: "user", text_excerpt: "always verify tests" },
            { id: "turn-6", session: "workflow-3", seq: 2n, ts: RECENT, role: "user", text_excerpt: "always verify tests" },
        ]);
        yield* write.putMany("tool_call", [
            {
                id: "edit-call",
                session: "parent",
                turn: "turn-1",
                name: "apply_patch",
                call_id: null,
                command_norm: "apply_patch",
                input_json: JSON.stringify({ patch: "*** Begin Patch\n+one\n-two\n*** End Patch" }),
                ts: RECENT,
            },
            {
                id: "dispatch-call",
                session: "parent",
                turn: "turn-1",
                name: "Agent",
                call_id: "dispatch-1",
                command_norm: null,
                input_json: JSON.stringify({ description: "implement mechanical test changes" }),
                ts: RECENT,
            },
        ]);
        yield* write.put("session_health", {
            id: "health-parent",
            session: "parent",
            source: "claude",
            user_corrections: 1n,
            task_label: "Verify live reads",
        });
        // ONE COMPLETE VERIFICATION EPISODE, so the churn parity case has
        // something to compare. `fetchSessionChurnSummary` gates every later
        // scan on `fetchChurnCandidateSessionIds`, which selects only sessions
        // holding a `command_outcome` with kind 'expected_feedback' or status
        // 'error' - with none seeded it returned empty aggregates from BOTH the
        // live reader and the published snapshot, and the assertion compared
        // [] to [] while proving nothing about the port.
        //
        // A failing check opens the episode and a same-family pass closes it;
        // both are `bun test`, so `checkFamilyFromCommand` maps them to one
        // family, and they sit well inside EPISODE_EXPIRY_MS (30 min).
        yield* write.putMany("command_outcome", [
            {
                id: "outcome-fail",
                session: "parent",
                tool_call: "edit-call",
                command_norm: "bun test",
                kind: "check",
                status: "error",
                ts: RECENT,
            },
            {
                id: "outcome-pass",
                session: "parent",
                tool_call: "edit-call",
                command_norm: "bun test",
                kind: "check",
                status: "ok",
                ts: new Date(RECENT.getTime() + 60_000),
            },
        ]);
        yield* write.put("fragility_cascade", {
            id: "cascade-live",
            origin: "parent",
            downstream: "child",
            weight: 2n,
        });
        yield* write.put("spawned", {
            id: "spawn-live",
            in_id: "parent",
            out_id: "child",
            ts: RECENT,
            agent_type: "general-purpose",
            description: "implement mechanical test changes",
            tool_use_id: "dispatch-1",
        });
        yield* write.put("session_token_usage", {
            id: "usage-child",
            session: "child",
            source: "claude-subagent",
            model: "claude-opus-4-1",
            prompt_tokens: 100n,
            completion_tokens: 20n,
            estimated_tokens: 120n,
            transcript_bytes: 480n,
            estimated_cost_usd: 0.25,
        });
        yield* write.put("content_type", { id: "binary", category: "binary", label: "image" });
        yield* write.put("has_content", {
            id: "content-live",
            in_id: "edit-call",
            out_id: "binary",
            method: "signature",
            bytes: 4_096n,
            session: "parent",
            ts: RECENT,
        });
        yield* write.putMany("edited", [
            { id: "edit-1", in_id: "turn-1", out_id: "file-live", tool: "Edit", ts: LATER, checkout: "checkout-main", path_seen: "/memory/live.md" },
            { id: "edit-2", in_id: "turn-2", out_id: "file-live", tool: "Edit", ts: LATER, checkout: "checkout-main", path_seen: "/memory/live.md" },
            { id: "edit-3", in_id: "turn-3", out_id: "file-live", tool: "Edit", ts: LATER, checkout: "checkout-main", path_seen: "/memory/live.md" },
            { id: "edit-4", in_id: "turn-4", out_id: "file-live", tool: "Edit", ts: LATER, checkout: "checkout-main", path_seen: "/memory/live.md" },
            { id: "edit-5", in_id: "turn-5", out_id: "file-live", tool: "Edit", ts: LATER, checkout: "checkout-main", path_seen: "/memory/live.md" },
            { id: "edit-6", in_id: "turn-6", out_id: "file-live", tool: "Edit", ts: LATER, checkout: "checkout-main", path_seen: "/memory/live.md" },
        ]);
        yield* write.put("checkout", { id: "checkout-main", repository: "repo-live", path: "/tmp/ax", branch: "main" });
        yield* write.put("produced", { id: "produced-live", in_id: "parent", out_id: "commit-live", checkout: "checkout-main", ts: RECENT });
        yield* write.putMany("skill", [
            { id: "skill-a", name: "skill-a", scope: "user", dir_path: "/skills/a", content_hash: "a" },
            { id: "skill-b", name: "skill-b", scope: "user", dir_path: "/skills/b", content_hash: "b" },
            { id: "skill-c", name: "skill-c", scope: "user", dir_path: "/skills/c", content_hash: "c" },
        ]);
        const workflowTurns = ["turn-1", "turn-3", "turn-5"] as const;
        const skillRows = ["skill-a", "skill-b", "skill-c"] as const;
        yield* write.putMany("invoked", workflowTurns.flatMap((turn, sessionIndex) =>
            skillRows.map((skill, skillIndex) => ({
                id: `invoked-${sessionIndex}-${skillIndex}`,
                in_id: turn,
                out_id: skill,
                session: sessionIndex === 0 ? "parent" : `workflow-${sessionIndex + 1}`,
                ts: new Date(RECENT.getTime() + skillIndex),
                turn_index: BigInt(skillIndex + 1),
                is_first: true,
            })),
        ));
        yield* write.putMany("otel_metric_point", [
            { id: "metric-cost", harness: "claude", metric: "claude_code.cost.usage", value: 0.5, session_id: "child", observed_at: RECENT },
            { id: "metric-token", harness: "claude", metric: "claude_code.token.usage", value: 10, session_id: "child", observed_at: RECENT },
        ]);
        yield* write.put("otel_log_event", {
            id: "log-live",
            harness: "claude",
            event_name: "usage",
            session_id: "child",
            input_tokens: 3,
            output_tokens: 2,
            duration_ms: 75,
            observed_at: RECENT,
        });
    });

const queryAll = (read: CacheReadService): Effect.Effect<LiveResults, unknown> =>
    Effect.gen(function* () {
        const [observedTooling, mainBranchGraph] = yield* Effect.all([
            fetchObservedTooling(read),
            fetchMainBranchGraphEvidence(read),
        ]);
        const [telemetryCost, telemetryLatency] = yield* Effect.all([
            sessionTelemetryCost(read, ["child"]),
            sessionTelemetryLatency(read, ["child"]),
        ]);
        return {
            costEstimate: yield* loadPricingCatalogForModels(read, []),
            fragilityCascade: yield* readFragilityCascade(read),
            sessionChurn: yield* fetchSessionChurnSummary(read, {
                since: null,
                limit: 20,
                generatedAt: NOW,
            }),
            sessionLoc: yield* computeSessionLoc(read, ["parent"]),
            sessionMetrics: yield* fetchSessionHealthMap(read, ["parent"]),
            projectHarness: { observedTooling, mainBranchGraph },
            directiveNgrams: yield* fetchDirectiveLift(read, { sinceDays: 14 }),
            dispatchAnalytics: yield* fetchDispatchCandidates(read, { sinceDays: 14 }),
            imageContext: yield* fetchImageContext(read, { sinceDays: 14, limit: 20 }),
            telemetryRollup: { telemetryCost, telemetryLatency },
            workflowSequences: yield* fetchWorkflowArcs(read),
        };
    });

const setupFixture = (): Promise<{ readonly snapshotPath: string; readonly live: LiveResults }> => {
    fixturePromise ??= runWithPlatform(
        Effect.gen(function* () {
            let live: LiveResults | undefined;
            const fixture = yield* publishCacheFixture(
                tempDir("ax-live-read-parity-"),
                dylibPath,
                (write) => Effect.gen(function* () {
                    yield* seedCurrentRows(write);
                    live = yield* queryAll(write);
                }),
            );
            if (live === undefined) return yield* Effect.die("live queries did not run");
            return { snapshotPath: fixture.snapshotPath, live };
        }),
    );
    return fixturePromise;
};

const snapshotResults = async (snapshotPath: string): Promise<LiveResults> =>
    Effect.runPromise(
        Effect.gen(function* () {
            const read = yield* CacheRead;
            return yield* queryAll(read);
        }).pipe(Effect.provide(readFixture(snapshotPath, dylibPath))) as Effect.Effect<LiveResults>,
    );

const assertParity = async (key: keyof LiveResults): Promise<void> => {
    const fixture = await setupFixture();
    const snapshot = await snapshotResults(fixture.snapshotPath);
    expect(snapshot[key]).toEqual(fixture.live[key]);
    if (key === "sessionLoc" || key === "sessionMetrics") {
        expect((snapshot[key] as ReadonlyMap<string, unknown>).size).toBeGreaterThan(0);
    }
    // Equality alone cannot tell "both sides agree" from "both sides are empty",
    // and an empty answer is exactly what a broken port produces. Every key that
    // returns a collection asserts it actually carries rows.
    if (key === "sessionChurn") {
        const churn = snapshot[key] as {
            readonly aggregates: ReadonlyArray<{ readonly episodes: number }>;
            readonly hotSessions: ReadonlyArray<unknown>;
        };
        expect(churn.aggregates.length).toBeGreaterThan(0);
        expect(churn.hotSessions.length).toBeGreaterThan(0);
        // The seeded fail -> same-family pass is one CLOSED episode.
        expect(churn.aggregates.reduce((sum, row) => sum + row.episodes, 0)).toBe(1);
    }
    if (key === "telemetryRollup") {
        const rollup = snapshot[key] as {
            readonly telemetryCost: ReadonlyMap<string, unknown>;
            readonly telemetryLatency: ReadonlyMap<string, unknown>;
        };
        expect(rollup.telemetryCost.size).toBeGreaterThan(0);
        expect(rollup.telemetryLatency.size).toBeGreaterThan(0);
    }
};

dtest("cost estimate reads the same live and published pricing rows", () => assertParity("costEstimate"));
dtest("fragility cascade reads the same live and published edges", () => assertParity("fragilityCascade"));
dtest("session churn reads the same live and published evidence", () => assertParity("sessionChurn"));
dtest("session LOC reads the same live and published tool calls", () => assertParity("sessionLoc"));
dtest("session metrics read the same live and published health rows", () => assertParity("sessionMetrics"));
dtest("project harness reads the same live and published graph rows", () => assertParity("projectHarness"));
dtest("directive n-grams read the same live and published turns", () => assertParity("directiveNgrams"));
dtest("dispatch analytics read the same live and published dispatches", () => assertParity("dispatchAnalytics"));
dtest("image context reads the same live and published content rows", () => assertParity("imageContext"));
dtest("telemetry rollup reads the same live and published telemetry", () => assertParity("telemetryRollup"));
dtest("workflow sequences read the same live and published invocations", () => assertParity("workflowSequences"));

dtest("fragility persistence deletes stale rows before it writes current rows", async () => {
    let liveRows: ReadonlyArray<{ readonly origin: string; readonly downstream: string }> = [];
    const fixture = await runWithPlatform(
        publishCacheFixture(tempDir("ax-fragility-delete-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("fragility_cascade", {
                    id: "stale",
                    origin: "old-origin",
                    downstream: "old-downstream",
                    weight: 9n,
                });
                yield* persistFragilityCascade(write, [{
                    origin: "new-origin",
                    downstream: "new-downstream",
                    weight: 1,
                    downstream_cost_usd: null,
                    downstream_tokens: null,
                }]);
                liveRows = yield* write.rows(
                    Schema.Struct({ origin: Schema.String, downstream: Schema.String }),
                    "SELECT origin, downstream FROM fragility_cascade ORDER BY origin",
                );
            }),
        ),
    );
    const snapshotRows = await Effect.runPromise(
        Effect.gen(function* () {
            const read = yield* CacheRead;
            return yield* read.rows(
                Schema.Struct({ origin: Schema.String, downstream: Schema.String }),
                "SELECT origin, downstream FROM fragility_cascade ORDER BY origin",
            );
        }).pipe(Effect.provide(readFixture(fixture.snapshotPath, dylibPath))) as Effect.Effect<ReadonlyArray<{
            readonly origin: string;
            readonly downstream: string;
        }>>,
    );
    expect(liveRows).toEqual([{ origin: "new-origin", downstream: "new-downstream" }]);
    expect(snapshotRows).toEqual(liveRows);
});
