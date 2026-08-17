import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { listPendingVerdicts } from "./verdict-pending.ts";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";

const layerWith = (...fixtures: unknown[][]) => {
    let i = 0;
    return judgmentTestLayer(() => fixtures[i++] ?? []);
};

describe("listPendingVerdicts", () => {
    test("returns experiments lacking locked_verdict with their proposal title", async () => {
        // created_at is only used to order the real query (ORDER BY, not
        // SELECT'd); it is included in the fixture rows below but the
        // Schema decode drops it from what listPendingVerdicts returns.
        const layer = layerWith([
            { id: "experiment:aaa", sig: "sig-aaa", title: "Stop using bare bun test", status: "scaffolded", created_at: new Date("2026-01-01T00:00:00Z") },
            { id: "experiment:bbb", sig: "sig-bbb", title: "Guard worktree merges", status: "task_emitted", created_at: new Date("2026-01-01T00:00:00Z") },
        ]);
        const rows = await Effect.runPromise(
            listPendingVerdicts().pipe(Effect.provide(layer)),
        );
        expect(rows).toMatchObject([
            { id: "experiment:aaa", sig: "sig-aaa", title: "Stop using bare bun test", status: "scaffolded" },
            { id: "experiment:bbb", sig: "sig-bbb", title: "Guard worktree merges", status: "task_emitted" },
        ]);
    });

    test("returns [] when no experiments are pending", async () => {
        const rows = await Effect.runPromise(
            listPendingVerdicts().pipe(Effect.provide(layerWith([]))),
        );
        expect(rows).toEqual([]);
    });
});
