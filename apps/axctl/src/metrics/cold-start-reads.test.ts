import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeColdStartReads } from "./cold-start-reads.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, { query: <T>(_sql: string) => Effect.succeed([rows] as unknown as T) } as never);

describe("computeColdStartReads", () => {
    test("counts reads/searches before the first edit", async () => {
        const rows = [
            { session: "session:`s1`", name: "Read", ts: "2026-06-01T00:00:01.000Z" },
            { session: "session:`s1`", name: "Grep", ts: "2026-06-01T00:00:02.000Z" },
            { session: "session:`s1`", name: "Edit", ts: "2026-06-01T00:00:03.000Z" },
            { session: "session:`s1`", name: "Read", ts: "2026-06-01T00:00:04.000Z" }, // after edit, excluded
        ];
        const out = await Effect.runPromise(computeColdStartReads(["session:`s1`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s1`")).toBe(2);
    });
    test("codex shell reads before an apply_patch edit count", async () => {
        const rows = [
            { session: "session:`cx`", name: "exec_command", command_norm: "cat", ts: "2026-06-01T00:00:01.000Z" },
            { session: "session:`cx`", name: "exec_command", command_norm: "rg", ts: "2026-06-01T00:00:02.000Z" },
            { session: "session:`cx`", name: "exec_command", command_norm: "sed", ts: "2026-06-01T00:00:03.000Z" },
            { session: "session:`cx`", name: "exec_command", command_norm: "apply_patch", ts: "2026-06-01T00:00:04.000Z" },
            { session: "session:`cx`", name: "exec_command", command_norm: "cat", ts: "2026-06-01T00:00:05.000Z" }, // after edit
        ];
        const out = await Effect.runPromise(computeColdStartReads(["session:`cx`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`cx`")).toBe(3);
    });
    test("claude Bash shell reads count alongside Read/Grep", async () => {
        const rows = [
            { session: "session:`b1`", name: "Bash", command_norm: "sed", ts: "2026-06-01T00:00:01.000Z" },
            { session: "session:`b1`", name: "Read", ts: "2026-06-01T00:00:02.000Z" },
            { session: "session:`b1`", name: "Write", ts: "2026-06-01T00:00:03.000Z" },
        ];
        const out = await Effect.runPromise(computeColdStartReads(["session:`b1`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`b1`")).toBe(2);
    });
    test("never edited → ALL reads/searches count", async () => {
        const rows = [
            { session: "session:`s2`", name: "Read", ts: "2026-06-01T00:00:01.000Z" },
            { session: "session:`s2`", name: "Glob", ts: "2026-06-01T00:00:02.000Z" },
            { session: "session:`s2`", name: "exec_command", command_norm: "rg", ts: "2026-06-01T00:00:03.000Z" },
        ];
        const out = await Effect.runPromise(computeColdStartReads(["session:`s2`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s2`")).toBe(3);
    });
    test("non-read non-edit shell rows are ignored", async () => {
        const rows = [
            { session: "session:`s5`", name: "Bash", command_norm: "bun", ts: "2026-06-01T00:00:01.000Z" },
            { session: "session:`s5`", name: "Read", ts: "2026-06-01T00:00:02.000Z" },
        ];
        const out = await Effect.runPromise(computeColdStartReads(["session:`s5`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s5`")).toBe(1);
    });
    test("no reads → 0", async () => {
        const rows = [{ session: "session:`s3`", name: "Edit", ts: "2026-06-01T00:00:01.000Z" }];
        const out = await Effect.runPromise(computeColdStartReads(["session:`s3`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s3`")).toBe(0);
    });
    test("absent session defaults to 0", async () => {
        const out = await Effect.runPromise(computeColdStartReads(["session:`sX`"]).pipe(Effect.provide(db([]))));
        expect(out.get("session:`sX`")).toBe(0);
    });
    test("empty input → empty map", async () => {
        const out = await Effect.runPromise(computeColdStartReads([]).pipe(Effect.provide(db([]))));
        expect(out.size).toBe(0);
    });
});
