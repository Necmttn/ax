import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeTimeToLand } from "./time-to-land.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, { query: <T>(_s: string) => Effect.succeed([rows] as unknown as T) } as never);

describe("computeTimeToLand", () => {
    test("ms from session.ended_at to earliest linked PR merged_at", async () => {
        const rows = [{ session: "session:`s1`", ms: 3600000 }];
        const out = await Effect.runPromise(computeTimeToLand(["session:`s1`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s1`")).toBe(3600000);
    });
    test("no linked merged PR → null", async () => {
        const out = await Effect.runPromise(computeTimeToLand(["session:`s9`"]).pipe(Effect.provide(db([]))));
        expect(out.get("session:`s9`")).toBe(null);
    });
    test("empty input → empty map", async () => {
        const out = await Effect.runPromise(computeTimeToLand([]).pipe(Effect.provide(db([]))));
        expect(out.size).toBe(0);
    });
});
