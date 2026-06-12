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
        const layer = layerWith([
            { id: "experiment:aaa", title: "Stop using bare bun test", status: "scaffolded" },
            { id: "experiment:bbb", title: "Guard worktree merges", status: "task_emitted" },
        ]);
        const rows = await Effect.runPromise(
            listPendingVerdicts().pipe(Effect.provide(layer)),
        );
        expect(rows).toEqual([
            { id: "experiment:aaa", title: "Stop using bare bun test", status: "scaffolded" },
            { id: "experiment:bbb", title: "Guard worktree merges", status: "task_emitted" },
        ]);
    });

    test("returns [] when no experiments are pending", async () => {
        const rows = await Effect.runPromise(
            listPendingVerdicts().pipe(Effect.provide(layerWith([]))),
        );
        expect(rows).toEqual([]);
    });
});
