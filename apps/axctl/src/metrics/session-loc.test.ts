import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeSessionLoc } from "./session-loc.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, { query: <T>(_s: string) => Effect.succeed([rows] as unknown as T) } as never);

describe("computeSessionLoc", () => {
    test("sums editDelta over a session's Edit/Write tool_calls", async () => {
        const rows = [
            { session: "session:`s1`", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb\nc" }) },
            { session: "session:`s1`", name: "Write", input_json: JSON.stringify({ content: "x\ny" }) },
        ];
        const out = await Effect.runPromise(computeSessionLoc(["session:`s1`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s1`")).toEqual({ added: 3 + 2, removed: 1 });
    });
    test("session with no edits → {added:0, removed:0}", async () => {
        const out = await Effect.runPromise(computeSessionLoc(["session:`s2`"]).pipe(Effect.provide(db([]))));
        expect(out.get("session:`s2`")).toEqual({ added: 0, removed: 0 });
    });
    test("empty input → empty map", async () => {
        const out = await Effect.runPromise(computeSessionLoc([]).pipe(Effect.provide(db([]))));
        expect(out.size).toBe(0);
    });
});
