import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { fetchCostSummary } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-queries/apps/axctl/src/dashboard/cost-query.ts";
import { fetchLocSummary } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-queries/apps/axctl/src/dashboard/loc-query.ts";
import { fetchOtelRollup } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-queries/apps/axctl/src/queries/otel-rollup.ts";
import { fetchSkillsWeighted } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-queries/apps/axctl/src/dashboard/skills-weighted.ts";
import { judgmentTestLayer } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-queries/apps/axctl/src/testing/judgment-test-layer.ts";
import { readFixture } from "@ax/lib/testing/cache-fixture";
import { fetchSessionInspect } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-queries/apps/axctl/src/dashboard/session-inspect.ts";
import { BunFileSystem, BunPath } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-queries/apps/axctl/node_modules/@effect/platform-bun/dist/index.js";

const { dylibPath, tempDir } = await duckdbTestSetup("audit-query-limit", { requireFts: true });

test("query limit selects the newest matching session", async () => {
  const fixture = await runWithPlatform(publishCacheFixture(tempDir("audit-query-limit-"), dylibPath, (w) =>
    Effect.gen(function* () {
      yield* w.putMany("session", [
        { id: "old", source: "codex", started_at: new Date("2026-01-01T00:00:00Z") },
        { id: "new", source: "codex", started_at: new Date("2026-08-01T00:00:00Z") },
      ]);
      yield* w.putMany("session_token_usage", [
        { id: "old", session: "old", source: "codex", estimated_tokens: 1, transcript_bytes: 1 },
        { id: "new", session: "new", source: "codex", estimated_tokens: 1, transcript_bytes: 1 },
      ]);
      yield* w.putMany("turn", [
        { id: "a-old", session: "old", seq: 1, ts: new Date("2026-01-01T00:00:00Z"), role: "user", text: "needle", text_excerpt: "needle" },
        { id: "z-new", session: "new", seq: 1, ts: new Date("2026-08-01T00:00:00Z"), role: "user", text: "needle", text_excerpt: "needle" },
      ]);
    })
  ));
  const result = await readThroughFixture(fixture, dylibPath, fetchCostSummary({ kind: "query", q: "needle", limit: 1 }));
  expect(result.sessions.map((row) => row.session)).toEqual(["new"]);
});

test("late inspector page keeps tool calls after row 4000", async () => {
  const fixture = await runWithPlatform(publishCacheFixture(tempDir("audit-inspect-tools-"), dylibPath, (w) =>
    Effect.gen(function* () {
      yield* w.put("session", { id: "s", source: "codex" });
      yield* w.put("session_health", { id: "sh", session: "s", source: "codex", turns: 4001 });
      yield* w.put("turn", { id: "t4001", session: "s", seq: 4001, role: "assistant", ts: new Date(), text: "done", has_tool_use: true });
      yield* w.putMany("tool_call", Array.from({ length: 4001 }, (_, i) => ({
        id: `tc${i + 1}`, session: "s", seq: i + 1, ts: new Date(), name: "Bash", input_json: "{}",
      })));
    })
  ));
  const result = await Effect.runPromise(fetchSessionInspect("s", { turnOffset: 4000, turnLimit: 1 }).pipe(Effect.provide(Layer.mergeAll(
    readFixture(fixture.snapshotPath, dylibPath), BunFileSystem.layer, BunPath.layer,
  ))));
  expect(result.turns[0]?.tool_calls).toHaveLength(1);
});

test("graph inspector totals cover the full session", async () => {
  const fixture = await runWithPlatform(publishCacheFixture(tempDir("audit-inspect-total-"), dylibPath, (w) =>
    Effect.gen(function* () {
      yield* w.put("session", { id: "s", source: "codex" });
      yield* w.put("session_health", { id: "sh", session: "s", source: "codex", turns: 2 });
      yield* w.putMany("turn", [
        { id: "t1", session: "s", seq: 1, role: "user", ts: new Date(), text: "12345" },
        { id: "t2", session: "s", seq: 2, role: "assistant", ts: new Date(), text: "67890" },
      ]);
    })
  ));
  const result = await Effect.runPromise(fetchSessionInspect("s", { turnOffset: 0, turnLimit: 1 }).pipe(Effect.provide(Layer.mergeAll(
    readFixture(fixture.snapshotPath, dylibPath), BunFileSystem.layer, BunPath.layer,
  ))));
  expect(result.total_chars).toBe(10);
});

test("recovery median counts each session once", async () => {
  const fixture = await runWithPlatform(publishCacheFixture(tempDir("audit-recovery-median-"), dylibPath, (w) =>
    Effect.gen(function* () {
      yield* w.put("skill", { id: "sk", name: "skill", scope: "user", dir_path: "/skills/skill", content_hash: "hash", bytes: 1 });
      yield* w.put("invoked", { id: "i", in_id: "t1", out_id: "sk", session: "s1", ts: new Date() });
      yield* w.putMany("turn", [
        { id: "t1", session: "s1", seq: 1, role: "assistant", ts: new Date() },
        { id: "t2", session: "s1", seq: 2, role: "assistant", ts: new Date() },
        { id: "t3", session: "s2", seq: 1, role: "assistant", ts: new Date() },
      ]);
      yield* w.putMany("recovered_by", [
        { id: "r1", in_id: "t1", out_id: "sk", ts: new Date() },
        { id: "r2", in_id: "t2", out_id: "sk", ts: new Date() },
        { id: "r3", in_id: "t3", out_id: "sk", ts: new Date() },
      ]);
      yield* w.putMany("otel_log_event", [
        { id: "e1", harness: "claude", event_name: "x", session_id: "s1", duration_ms: 100, observed_at: new Date() },
        { id: "e2", harness: "claude", event_name: "x", session_id: "s2", duration_ms: 1000, observed_at: new Date() },
      ]);
    })
  ));
  const result = await Effect.runPromise(fetchSkillsWeighted().pipe(Effect.provide(Layer.mergeAll(
    readFixture(fixture.snapshotPath, dylibPath),
    judgmentTestLayer(() => []),
  ))));
  expect(result.rows[0]?.median_recovery_ms).toBe(550);
});

test("otel coverage excludes a UUID codex subagent", async () => {
  const fixture = await runWithPlatform(publishCacheFixture(tempDir("audit-otel-subagent-"), dylibPath, (w) =>
    w.put("session", {
      id: "11111111-1111-4111-8111-111111111111",
      source: "codex-subagent",
      started_at: new Date(),
    })
  ));
  const result = await readThroughFixture(fixture, dylibPath, fetchOtelRollup({ sinceDays: 14 }));
  expect(result.coverage.window_sessions).toBe(0);
});

test("loc query limit selects the newest matching session", async () => {
  const fixture = await runWithPlatform(publishCacheFixture(tempDir("audit-loc-limit-"), dylibPath, (w) =>
    Effect.gen(function* () {
      yield* w.putMany("session", [
        { id: "old", source: "codex", started_at: new Date("2026-01-01T00:00:00Z") },
        { id: "new", source: "codex", started_at: new Date("2026-08-01T00:00:00Z") },
      ]);
      yield* w.putMany("turn", [
        { id: "a-old", session: "old", seq: 1, ts: new Date("2026-01-01T00:00:00Z"), role: "user", text: "needle", text_excerpt: "needle" },
        { id: "z-new", session: "new", seq: 1, ts: new Date("2026-08-01T00:00:00Z"), role: "user", text: "needle", text_excerpt: "needle" },
      ]);
      yield* w.putMany("tool_call", [
        { id: "old-edit", session: "old", seq: 2, ts: new Date("2026-01-01T00:01:00Z"), name: "Write", input_json: '{"content":"old"}' },
        { id: "new-edit", session: "new", seq: 2, ts: new Date("2026-08-01T00:01:00Z"), name: "Write", input_json: '{"content":"new"}' },
      ]);
    })
  ));
  const result = await readThroughFixture(fixture, dylibPath, fetchLocSummary({ kind: "query", terms: ["needle"], limit: 1 }));
  expect(result.sessions.map((row) => row.session)).toEqual(["new"]);
});
