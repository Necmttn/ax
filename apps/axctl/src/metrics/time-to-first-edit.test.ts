import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeTimeToFirstEdit } from "./time-to-first-edit.ts";
import { SurrealClient } from "@ax/lib/db";

// Route the two reads: GROUP BY first_edit (FROM tool_call) and the session
// start (FROM session WHERE id IN).
const db = (firstEdits: Array<Record<string, unknown>>, starts: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/FROM tool_call/.test(sql)) return Effect.succeed([firstEdits] as unknown as T);
            if (/FROM session/.test(sql)) return Effect.succeed([starts] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

describe("computeTimeToFirstEdit", () => {
    test("ms from started_at to first edit", async () => {
        const firstEdits = [
            { session: "session:`s1`", first_edit: "2026-06-01T00:01:00.000Z" },
            { session: "session:`s2`", first_edit: "2026-06-01T00:00:30.000Z" },
        ];
        const starts = [
            { session: "session:`s1`", started_at: "2026-06-01T00:00:00.000Z" },
            { session: "session:`s2`", started_at: "2026-06-01T00:00:00.000Z" },
        ];
        const out = await Effect.runPromise(
            computeTimeToFirstEdit(["session:`s1`", "session:`s2`"]).pipe(Effect.provide(db(firstEdits, starts))),
        );
        expect(out.get("session:`s1`")).toBe(60_000);
        expect(out.get("session:`s2`")).toBe(30_000);
    });
    test("session that never edited → null, not 0", async () => {
        const starts = [{ session: "session:`s3`", started_at: "2026-06-01T00:00:00.000Z" }];
        const out = await Effect.runPromise(
            computeTimeToFirstEdit(["session:`s3`"]).pipe(Effect.provide(db([], starts))),
        );
        expect(out.get("session:`s3`")).toBeNull();
    });
    test("negative delta (edit before start) → null", async () => {
        const firstEdits = [{ session: "session:`s4`", first_edit: "2026-06-01T00:00:00.000Z" }];
        const starts = [{ session: "session:`s4`", started_at: "2026-06-01T00:01:00.000Z" }];
        const out = await Effect.runPromise(
            computeTimeToFirstEdit(["session:`s4`"]).pipe(Effect.provide(db(firstEdits, starts))),
        );
        expect(out.get("session:`s4`")).toBeNull();
    });
    test("missing start time → null", async () => {
        const firstEdits = [{ session: "session:`s5`", first_edit: "2026-06-01T00:01:00.000Z" }];
        const out = await Effect.runPromise(
            computeTimeToFirstEdit(["session:`s5`"]).pipe(Effect.provide(db(firstEdits, []))),
        );
        expect(out.get("session:`s5`")).toBeNull();
    });
    test("empty input → empty map", async () => {
        const out = await Effect.runPromise(computeTimeToFirstEdit([]).pipe(Effect.provide(db([], []))));
        expect(out.size).toBe(0);
    });
});
