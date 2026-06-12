import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { listPendingVerdicts } from "./verdict-pending.ts";
import { SurrealClient } from "@ax/lib/db";

const layerWith = (...fixtures: unknown[][]) => {
    let i = 0;
    return Layer.succeed(SurrealClient, {
        query: <T>(_: string) => Effect.succeed([(fixtures[i++] ?? [])] as unknown as T),
    } as never);
};

describe("listPendingVerdicts", () => {
    test("returns experiments lacking locked_verdict with their proposal title", async () => {
        // created_at is in the projection only to satisfy SurrealDB's
        // ORDER BY rules; the query must strip it from returned rows.
        const layer = layerWith([
            { id: "experiment:aaa", sig: "sig-aaa", title: "Stop using bare bun test", status: "scaffolded", created_at: "2026-01-01T00:00:00Z" },
            { id: "experiment:bbb", sig: "sig-bbb", title: "Guard worktree merges", status: "task_emitted", created_at: "2026-01-01T00:00:00Z" },
        ]);
        const rows = await Effect.runPromise(
            listPendingVerdicts().pipe(Effect.provide(layer)),
        );
        expect(rows).toEqual([
            { id: "experiment:aaa", sig: "sig-aaa", title: "Stop using bare bun test", status: "scaffolded" },
            { id: "experiment:bbb", sig: "sig-bbb", title: "Guard worktree merges", status: "task_emitted" },
        ]);
        expect(rows[0]).not.toHaveProperty("created_at");
    });

    test("returns [] when no experiments are pending", async () => {
        const rows = await Effect.runPromise(
            listPendingVerdicts().pipe(Effect.provide(layerWith([]))),
        );
        expect(rows).toEqual([]);
    });
});
