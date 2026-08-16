import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { computeTimeToFirstEdit as computeTimeToFirstEditWithRead } from "./time-to-first-edit.ts";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { makeTestCacheRead } from "@ax/lib/testing/cache";

// Route the two reads: edit-class rows (FROM tool_call) and the session
// starts (direct record access `FROM [session:...]`).
const db = (editRows: Array<Record<string, unknown>>, starts: Array<Record<string, unknown>>) =>
    makeTestCacheRead({ routes: [
        { match: /FROM tool_call/, rows: editRows },
        { match: /FROM session/, rows: starts },
    ] }).layer;
const computeTimeToFirstEdit = (ids: readonly string[]) => Effect.gen(function* () {
    return yield* computeTimeToFirstEditWithRead(yield* CacheRead, ids);
});

describe("computeTimeToFirstEdit", () => {
    test("ms from started_at to first edit", async () => {
        const editRows = [
            { session: "session:`s1`", name: "Edit", ts: "2026-06-01T00:01:00.000Z" },
            { session: "session:`s1`", name: "Write", ts: "2026-06-01T00:02:00.000Z" },
            { session: "session:`s2`", name: "Edit", ts: "2026-06-01T00:00:30.000Z" },
        ];
        const starts = [
            { session: "session:`s1`", started_at: "2026-06-01T00:00:00.000Z" },
            { session: "session:`s2`", started_at: "2026-06-01T00:00:00.000Z" },
        ];
        const out = await Effect.runPromise(
            computeTimeToFirstEdit(["session:`s1`", "session:`s2`"]).pipe(Effect.provide(db(editRows, starts))),
        );
        expect(out.get("session:`s1`")).toBe(60_000);
        expect(out.get("session:`s2`")).toBe(30_000);
    });
    test("codex apply_patch via exec_command counts as the first edit", async () => {
        const editRows = [
            { session: "session:`cx`", name: "exec_command", command_norm: "apply_patch", ts: "2026-06-01T00:00:45.000Z" },
        ];
        const starts = [{ session: "session:`cx`", started_at: "2026-06-01T00:00:00.000Z" }];
        const out = await Effect.runPromise(
            computeTimeToFirstEdit(["session:`cx`"]).pipe(Effect.provide(db(editRows, starts))),
        );
        expect(out.get("session:`cx`")).toBe(45_000);
    });
    test("non-edit rows that slip through the SQL filter are ignored", async () => {
        const editRows = [
            { session: "session:`s6`", name: "Bash", command_norm: "bun", ts: "2026-06-01T00:00:10.000Z" },
        ];
        const starts = [{ session: "session:`s6`", started_at: "2026-06-01T00:00:00.000Z" }];
        const out = await Effect.runPromise(
            computeTimeToFirstEdit(["session:`s6`"]).pipe(Effect.provide(db(editRows, starts))),
        );
        expect(out.get("session:`s6`")).toBeNull();
    });
    test("session that never edited → null, not 0", async () => {
        const starts = [{ session: "session:`s3`", started_at: "2026-06-01T00:00:00.000Z" }];
        const out = await Effect.runPromise(
            computeTimeToFirstEdit(["session:`s3`"]).pipe(Effect.provide(db([], starts))),
        );
        expect(out.get("session:`s3`")).toBeNull();
    });
    test("negative delta (edit before start) → null", async () => {
        const editRows = [{ session: "session:`s4`", name: "Edit", ts: "2026-06-01T00:00:00.000Z" }];
        const starts = [{ session: "session:`s4`", started_at: "2026-06-01T00:01:00.000Z" }];
        const out = await Effect.runPromise(
            computeTimeToFirstEdit(["session:`s4`"]).pipe(Effect.provide(db(editRows, starts))),
        );
        expect(out.get("session:`s4`")).toBeNull();
    });
    test("missing start time → null", async () => {
        const editRows = [{ session: "session:`s5`", name: "Edit", ts: "2026-06-01T00:01:00.000Z" }];
        const out = await Effect.runPromise(
            computeTimeToFirstEdit(["session:`s5`"]).pipe(Effect.provide(db(editRows, []))),
        );
        expect(out.get("session:`s5`")).toBeNull();
    });
    test("empty input → empty map", async () => {
        const out = await Effect.runPromise(computeTimeToFirstEdit([]).pipe(Effect.provide(db([], []))));
        expect(out.size).toBe(0);
    });
});
