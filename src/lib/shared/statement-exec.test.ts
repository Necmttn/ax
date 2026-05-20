import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { executeStatements } from "./statement-exec.ts";
import { SurrealClient, type SurrealClientShape } from "../db.ts";

/** In-memory recorder adapter - the second adapter that makes this a real seam. */
const recordingClient = (): { calls: string[]; layer: SurrealClientShape } => {
    const calls: string[] = [];
    const layer = {
        query: <T extends unknown[]>(sql: string) => {
            calls.push(sql);
            return Effect.succeed([] as unknown as T);
        },
        upsert: () => Effect.succeed(undefined),
        relate: () => Effect.succeed(undefined),
        putFile: () => Effect.succeed(undefined),
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    } satisfies SurrealClientShape;
    return { calls, layer };
};

const run = (eff: Effect.Effect<unknown, unknown, SurrealClient>, layer: SurrealClientShape) =>
    Effect.runPromise(eff.pipe(Effect.provideService(SurrealClient, layer)));

describe("executeStatements", () => {
    test("no statements → no query call", async () => {
        const { calls, layer } = recordingClient();
        await run(executeStatements([]), layer);
        expect(calls).toEqual([]);
    });

    test("statements within one chunk → a single joined query", async () => {
        const { calls, layer } = recordingClient();
        await run(executeStatements(["A;", "B;"]), layer);
        expect(calls).toEqual(["A;B;"]);
    });

    test("chunkSize splits into multiple queries", async () => {
        const { calls, layer } = recordingClient();
        await run(executeStatements(["A;", "B;", "C;"], { chunkSize: 2 }), layer);
        expect(calls).toEqual(["A;B;", "C;"]);
    });

    test("default chunk size is 250", async () => {
        const { calls, layer } = recordingClient();
        const stmts = Array.from({ length: 251 }, (_, i) => `S${i};`);
        await run(executeStatements(stmts), layer);
        expect(calls.length).toBe(2);
    });
});
