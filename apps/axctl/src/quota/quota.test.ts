import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { isFresh, loadQuotaCache, saveQuotaCache } from "./cache.ts";
import { QuotaEnvTest } from "./quota-env.ts";
import { getQuota } from "./quota.ts";
import type { QuotaSnapshot } from "./schema.ts";

const NOW_MS = Date.parse("2026-06-12T12:00:00.000Z");

const USAGE_PAYLOAD = {
    five_hour: { utilization: 88.0, resets_at: "2026-06-12T15:30:00.000Z" },
    seven_day: { utilization: 51.0, resets_at: "2026-06-15T21:00:00.000Z" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: null,
};

const snapshotAt = (fetchedAtIso: string): QuotaSnapshot => ({
    v: 1,
    fetched_at: fetchedAtIso,
    five_hour: { utilization: 12, resets_at: "2026-06-12T15:30:00.000Z" },
    seven_day: { utilization: 3, resets_at: "2026-06-15T21:00:00.000Z" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: null,
});

const tmpPaths: string[] = [];
const tmpCachePath = (name: string): string => {
    const path = `/tmp/ax-quota-test-${process.pid}-${name}.json`;
    tmpPaths.push(path);
    return path;
};

afterEach(() => {
    for (const path of tmpPaths.splice(0)) Bun.spawnSync(["rm", "-f", path]);
});

describe("cache", () => {
    test("save/load round-trip; missing + corrupt load as null", async () => {
        const path = tmpCachePath("roundtrip");
        const snapshot = snapshotAt("2026-06-12T11:59:00.000Z");
        await saveQuotaCache(path, snapshot);
        expect(await loadQuotaCache(path)).toEqual(snapshot);
        expect(await loadQuotaCache(`${path}.missing`)).toBeNull();
        await Bun.write(path, "{corrupt");
        expect(await loadQuotaCache(path)).toBeNull();
    });

    test("isFresh respects TTL and malformed timestamps", () => {
        expect(isFresh(snapshotAt("2026-06-12T11:59:30.000Z"), NOW_MS, 60)).toBe(true);
        expect(isFresh(snapshotAt("2026-06-12T11:58:00.000Z"), NOW_MS, 60)).toBe(false);
        expect(isFresh(snapshotAt("garbage"), NOW_MS, 60)).toBe(false);
        // TTL 0 = force refetch even for a snapshot from "now"
        expect(isFresh(snapshotAt("2026-06-12T12:00:00.000Z"), NOW_MS, 0)).toBe(false);
    });
});

describe("getQuota", () => {
    test("fresh cache short-circuits the fetch", async () => {
        const path = tmpCachePath("fresh");
        await saveQuotaCache(path, snapshotAt("2026-06-12T11:59:30.000Z"));
        const env = QuotaEnvTest({ token: "tok", usage: USAGE_PAYLOAD });
        const result = await Effect.runPromise(
            getQuota({ cachePath: path, maxAgeSeconds: 60, nowMs: NOW_MS }).pipe(
                Effect.provide(env.layer),
            ),
        );
        expect(result.source).toBe("cache");
        expect(result.snapshot.five_hour?.utilization).toBe(12);
        expect(env.fetchCalls).toEqual([]);
    });

    test("stale cache triggers live fetch and rewrites the cache", async () => {
        const path = tmpCachePath("stale");
        await saveQuotaCache(path, snapshotAt("2026-06-12T11:00:00.000Z"));
        const env = QuotaEnvTest({ token: "tok", usage: USAGE_PAYLOAD });
        const result = await Effect.runPromise(
            getQuota({ cachePath: path, maxAgeSeconds: 60, nowMs: NOW_MS }).pipe(
                Effect.provide(env.layer),
            ),
        );
        expect(result.source).toBe("live");
        expect(result.snapshot.five_hour?.utilization).toBe(88);
        expect(env.fetchCalls).toEqual(["tok"]);
        expect((await loadQuotaCache(path))?.five_hour?.utilization).toBe(88);
    });

    test("fetch failure falls back to stale cache", async () => {
        const path = tmpCachePath("fallback");
        await saveQuotaCache(path, snapshotAt("2026-06-12T11:00:00.000Z"));
        const env = QuotaEnvTest({
            token: "tok",
            usage: { __error: { status: 503, message: "down" } },
        });
        const result = await Effect.runPromise(
            getQuota({ cachePath: path, maxAgeSeconds: 60, nowMs: NOW_MS }).pipe(
                Effect.provide(env.layer),
            ),
        );
        expect(result.source).toBe("stale-cache");
        expect(result.snapshot.five_hour?.utilization).toBe(12);
    });

    test("no token + no cache fails QuotaTokenMissing", async () => {
        const env = QuotaEnvTest({ token: null });
        const exit = await Effect.runPromiseExit(
            getQuota({
                cachePath: tmpCachePath("notoken"),
                maxAgeSeconds: 60,
                nowMs: NOW_MS,
            }).pipe(Effect.provide(env.layer)),
        );
        expect(exit._tag).toBe("Failure");
    });

    test("no token + stale cache degrades to stale-cache", async () => {
        const path = tmpCachePath("notoken-stale");
        await saveQuotaCache(path, snapshotAt("2026-06-12T11:00:00.000Z"));
        const env = QuotaEnvTest({ token: null });
        const result = await Effect.runPromise(
            getQuota({ cachePath: path, maxAgeSeconds: 60, nowMs: NOW_MS }).pipe(
                Effect.provide(env.layer),
            ),
        );
        expect(result.source).toBe("stale-cache");
    });

    test("fetch failure with no cache propagates the api error", async () => {
        const env = QuotaEnvTest({
            token: "tok",
            usage: { __error: { status: 401, message: "expired" } },
        });
        const exit = await Effect.runPromiseExit(
            getQuota({
                cachePath: tmpCachePath("hardfail"),
                maxAgeSeconds: 60,
                nowMs: NOW_MS,
            }).pipe(Effect.provide(env.layer)),
        );
        expect(exit._tag).toBe("Failure");
    });
});
