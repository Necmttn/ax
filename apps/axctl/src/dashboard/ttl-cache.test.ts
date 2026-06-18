import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { makeTtlCachedFetch } from "./ttl-cache.ts";

class CacheComputeError extends Schema.TaggedErrorClass<CacheComputeError>(
    "CacheComputeError",
)("CacheComputeError", {
    message: Schema.String,
}) {}

describe("makeTtlCachedFetch", () => {
    test("caches within TTL, single compute shared", async () => {
        let computes = 0;
        const cache = makeTtlCachedFetch(
            "test",
            () => Effect.sync(() => { computes += 1; return computes; }),
            "1 minute",
        );
        const a = await Effect.runPromise(cache.fetch());
        const b = await Effect.runPromise(cache.fetch());
        expect(a).toBe(1);
        expect(b).toBe(1);
        expect(computes).toBe(1);
    });

    test("invalidate forces a fresh compute", async () => {
        let computes = 0;
        const cache = makeTtlCachedFetch(
            "test",
            () => Effect.sync(() => { computes += 1; return computes; }),
            "1 minute",
        );
        await Effect.runPromise(cache.fetch());
        await Effect.runPromise(cache.invalidate());
        const after = await Effect.runPromise(cache.fetch());
        expect(after).toBe(2);
        expect(computes).toBe(2);
    });

    test("invalidate before first fetch is a no-op", async () => {
        const cache = makeTtlCachedFetch("test", () => Effect.succeed(42), "1 minute");
        await Effect.runPromise(cache.invalidate());
        expect(await Effect.runPromise(cache.fetch())).toBe(42);
    });

    test("a failed compute is NOT cached - next fetch retries", async () => {
        let calls = 0;
        const cache = makeTtlCachedFetch(
            "test",
            () =>
	                Effect.suspend(() => {
	                    calls += 1;
	                    return calls === 1
	                        ? Effect.fail(new CacheComputeError({ message: "db hiccup" }))
	                        : Effect.succeed(calls);
	                }),
            "1 minute",
        );
        await expect(Effect.runPromise(cache.fetch())).rejects.toThrow("db hiccup");
        const second = await Effect.runPromise(cache.fetch());
        expect(second).toBe(2);
        expect(calls).toBe(2);
    });

    test("concurrent first callers share one compute", async () => {
        let computes = 0;
        const cache = makeTtlCachedFetch(
            "test",
            () => Effect.sync(() => { computes += 1; return computes; }).pipe(Effect.delay("10 millis")),
            "1 minute",
        );
        const [a, b] = await Effect.runPromise(
            Effect.all([cache.fetch(), cache.fetch()], { concurrency: 2 }),
        );
        expect(a).toBe(1);
        expect(b).toBe(1);
        expect(computes).toBe(1);
    });
});
