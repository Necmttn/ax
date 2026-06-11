import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { DbError } from "@ax/lib/errors";
import { type FileFailureSnapshot, makeFileFailureCollector } from "./file-isolation.ts";

const queryError = (message: string) => new DbError({ operation: "query", message });
const connectError = () => new DbError({ operation: "connect", message: "daemon not reachable" });

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromiseExit(eff);

describe("makeFileFailureCollector", () => {
    test("success passes through and records nothing", async () => {
        const c = makeFileFailureCollector({ source: "test" });
        const exit = await run(c.isolate("/a.jsonl", Effect.succeed(42)));
        expect(exit).toEqual(Exit.succeed(42));
        expect(c.count()).toBe(0);
        expect(c.failures).toEqual([]);
    });

    test("a typed failure is swallowed, recorded, and yields undefined", async () => {
        const c = makeFileFailureCollector({ source: "test" });
        const exit = await run(c.isolate("/bad.jsonl", Effect.fail(queryError("boom"))));
        expect(exit).toEqual(Exit.succeed(undefined));
        expect(c.count()).toBe(1);
        expect(c.failures).toEqual([{ filePath: "/bad.jsonl", tag: "DbError", message: "boom" }]);
    });

    test("connection errors propagate (stage must abort)", async () => {
        const c = makeFileFailureCollector({ source: "test" });
        const exit = await run(c.isolate("/a.jsonl", Effect.fail(connectError())));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(c.count()).toBe(0);
    });

    test("a failure storm aborts after the threshold", async () => {
        const c = makeFileFailureCollector({ source: "test", stormThreshold: 3 });
        expect(Exit.isSuccess(await run(c.isolate("/1", Effect.fail(queryError("x")))))).toBe(true);
        expect(Exit.isSuccess(await run(c.isolate("/2", Effect.fail(queryError("x")))))).toBe(true);
        const third = await run(c.isolate("/3", Effect.fail(queryError("x"))));
        expect(Exit.isFailure(third)).toBe(true);
        if (Exit.isFailure(third)) {
            expect(String(third.cause)).toContain("3 consecutive files failed");
        }
    });

    test("an interleaved success resets the storm counter", async () => {
        const c = makeFileFailureCollector({ source: "test", stormThreshold: 3 });
        await run(c.isolate("/1", Effect.fail(queryError("x"))));
        await run(c.isolate("/2", Effect.fail(queryError("x"))));
        await run(c.isolate("/ok", Effect.succeed(1)));
        const next = await run(c.isolate("/3", Effect.fail(queryError("x"))));
        expect(Exit.isSuccess(next)).toBe(true);
        expect(c.count()).toBe(3);
    });

    test("detail list caps but the count keeps growing", async () => {
        const c = makeFileFailureCollector({ source: "test", stormThreshold: 1000 });
        for (let i = 0; i < 30; i++) {
            // alternate success to dodge the storm counter
            await run(c.isolate("/ok", Effect.succeed(1)));
            await run(c.isolate(`/f${i}`, Effect.fail(queryError("x"))));
        }
        expect(c.count()).toBe(30);
        expect(c.failures.length).toBe(25);
    });

    test("defects are not isolated", async () => {
        const c = makeFileFailureCollector({ source: "test" });
        const exit = await run(c.isolate("/a", Effect.die(new Error("bug"))));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(c.count()).toBe(0);
    });

    test("onFailure receives a cumulative snapshot per recorded failure, never on success", async () => {
        const snapshots: FileFailureSnapshot[] = [];
        const c = makeFileFailureCollector({
            source: "test",
            onFailure: (snapshot) => Effect.sync(() => snapshots.push(snapshot)),
        });
        await run(c.isolate("/ok", Effect.succeed(1)));
        expect(snapshots).toEqual([]);
        await run(c.isolate("/a.jsonl", Effect.fail(queryError("boom"))));
        await run(c.isolate("/b.jsonl", Effect.fail(queryError("crash"))));
        expect(snapshots).toEqual([
            { total: 1, failures: [{ filePath: "/a.jsonl", tag: "DbError", message: "boom" }] },
            {
                total: 2,
                failures: [
                    { filePath: "/a.jsonl", tag: "DbError", message: "boom" },
                    { filePath: "/b.jsonl", tag: "DbError", message: "crash" },
                ],
            },
        ]);
        // Snapshots are independent copies - later failures must not mutate
        // an earlier snapshot a consumer already holds.
        expect(snapshots[0].failures.length).toBe(1);
    });

    test("onFailure keeps reporting the uncapped total past the detail cap", async () => {
        const snapshots: FileFailureSnapshot[] = [];
        const c = makeFileFailureCollector({
            source: "test",
            stormThreshold: 1000,
            onFailure: (snapshot) => Effect.sync(() => snapshots.push(snapshot)),
        });
        for (let i = 0; i < 30; i++) {
            await run(c.isolate("/ok", Effect.succeed(1)));
            await run(c.isolate(`/f${i}`, Effect.fail(queryError("x"))));
        }
        const last = snapshots.at(-1);
        expect(last?.total).toBe(30);
        expect(last?.failures.length).toBe(25);
    });

    test("report is a no-op at zero failures and logs otherwise", async () => {
        const clean = makeFileFailureCollector({ source: "test" });
        await Effect.runPromise(clean.report);
        const dirty = makeFileFailureCollector({ source: "test" });
        await run(dirty.isolate("/bad", Effect.fail(queryError("boom"))));
        await Effect.runPromise(dirty.report);
        expect(dirty.count()).toBe(1);
    });
});
