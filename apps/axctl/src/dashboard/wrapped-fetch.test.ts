/**
 * fetchWrapped tests against a REAL published DuckDB cache fixture - exercises
 * the actual SQL translation (wrapped-cache.test.ts only stubs `raw()` to
 * verify TTL caching behavior; the pure aggregation/archetype functions are
 * covered separately in wrapped.test.ts).
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { fetchWrapped } from "./wrapped.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("wrapped-fetch");

const now = new Date();

const FIXTURE = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            { id: "s1", project: "ax", started_at: now, ended_at: now, model: "claude-opus-5", repository: "ax" },
        ]);
        yield* w.putMany("turn", [
            { id: "t1", session: "s1", seq: 1, ts: now, role: "user" },
            { id: "t2", session: "s1", seq: 2, ts: now, role: "assistant" },
        ]);
        yield* w.putMany("skill", [
            { id: "sk-tdd", name: "tdd", scope: "user", dir_path: "/skills/tdd", content_hash: "h1" },
        ]);
        yield* w.putMany("invoked", [
            { id: "iv1", in_id: "t1", out_id: "sk-tdd", ts: now, session: "s1", was_corrected: false },
        ]);
        yield* w.putMany("tool_call", [
            { id: "tc1", session: "s1", name: "Bash", command_norm: "git status", command_text: "git status", ts: now, has_error: false },
            { id: "tc2", session: "s1", name: "Bash", command_norm: "bun test", command_text: "bun test", ts: now, has_error: true },
        ]);
        yield* w.putMany("session_token_usage", [
            { id: "stu1", session: "s1", source: "claude", estimated_tokens: 1000, prompt_tokens: 600, completion_tokens: 400, transcript_bytes: 10, ts: now },
        ]);
        yield* w.putMany("spawned", [
            { id: "sp1", in_id: "s1", out_id: "s1", ts: now },
        ]);
    });

describe("fetchWrapped (real DuckDB fixture)", () => {
    dtest("aggregates usage/tools/skills/model/tokens into a WrappedProfile", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-wrapped-"), dylibPath, FIXTURE));
        const profile = await readThroughFixture(fixture, dylibPath, fetchWrapped());

        expect(profile.usage.sessions).toBe(1);
        expect(profile.usage.messages).toBe(2);
        expect(profile.usage.favoriteModel).toBe("claude-opus-5");
        expect(profile.usage.totalTokens).toBe(1000);
        expect(profile.metrics.toolCalls).toBe(2);
        expect(profile.metrics.toolFailures).toBe(1);
        expect(profile.metrics.distinctSkills).toBe(1);
        expect(profile.metrics.repositories).toBe(1);
        expect(profile.metrics.spawnedAgents).toBe(1);
        expect(profile.facts.length).toBeGreaterThan(0);
    });

    dtest("empty fixture degrades to a zero-valued profile, not a crash", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-wrapped-empty-"), dylibPath, () => Effect.void));
        const profile = await readThroughFixture(fixture, dylibPath, fetchWrapped());

        expect(profile.usage.sessions).toBe(0);
        expect(profile.usage.totalTokens).toBeNull();
        expect(profile.metrics.toolCalls).toBe(0);
    });
});
