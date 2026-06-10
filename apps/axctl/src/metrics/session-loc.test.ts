import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { applyPatchDelta, computeSessionLoc } from "./session-loc.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, { query: <T>(_s: string) => Effect.succeed([rows] as unknown as T) } as never);

const PATCH = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@",
    "-old line",
    "+new line",
    "+another line",
    "*** End Patch",
].join("\n");

describe("applyPatchDelta", () => {
    test("counts +/- body lines from a `patch` field", () => {
        expect(applyPatchDelta(JSON.stringify({ patch: PATCH }))).toEqual({ added: 2, removed: 1 });
    });
    test("reads the exec_command `command` field (heredoc form)", () => {
        const command = `apply_patch <<'EOF'\n${PATCH}\nEOF`;
        expect(applyPatchDelta(JSON.stringify({ command }))).toEqual({ added: 2, removed: 1 });
    });
    test("skips +++/--- unified-diff headers", () => {
        const diff = "--- a/x.ts\n+++ b/x.ts\n@@\n-gone\n+here";
        expect(applyPatchDelta(JSON.stringify({ diff }))).toEqual({ added: 1, removed: 1 });
    });
    test("unparsable shapes → zeros", () => {
        expect(applyPatchDelta(null)).toEqual({ added: 0, removed: 0 });
        expect(applyPatchDelta("not json")).toEqual({ added: 0, removed: 0 });
        expect(applyPatchDelta(JSON.stringify({ other: 1 }))).toEqual({ added: 0, removed: 0 });
        expect(applyPatchDelta(JSON.stringify([1, 2]))).toEqual({ added: 0, removed: 0 });
    });
});

describe("computeSessionLoc", () => {
    test("sums editDelta over a session's Edit/Write tool_calls", async () => {
        const rows = [
            { session: "session:`s1`", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb\nc" }) },
            { session: "session:`s1`", name: "Write", input_json: JSON.stringify({ content: "x\ny" }) },
        ];
        const out = await Effect.runPromise(computeSessionLoc(["session:`s1`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s1`")).toEqual({ added: 3 + 2, removed: 1 });
    });
    test("codex apply_patch tool calls count patch lines", async () => {
        const rows = [
            { session: "session:`cx`", name: "apply_patch", input_json: JSON.stringify({ patch: PATCH }) },
        ];
        const out = await Effect.runPromise(computeSessionLoc(["session:`cx`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`cx`")).toEqual({ added: 2, removed: 1 });
    });
    test("codex exec_command apply_patch (command_norm) counts patch lines", async () => {
        const rows = [
            {
                session: "session:`cx2`",
                name: "exec_command",
                command_norm: "apply_patch",
                input_json: JSON.stringify({ command: `apply_patch <<'EOF'\n${PATCH}\nEOF` }),
            },
        ];
        const out = await Effect.runPromise(computeSessionLoc(["session:`cx2`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`cx2`")).toEqual({ added: 2, removed: 1 });
    });
    test("lowercase provider edit names map onto editDelta", async () => {
        const rows = [
            { session: "session:`pi`", name: "edit", input_json: JSON.stringify({ old_string: "a\nb", new_string: "c" }) },
        ];
        const out = await Effect.runPromise(computeSessionLoc(["session:`pi`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`pi`")).toEqual({ added: 1, removed: 2 });
    });
    test("non-edit rows that slip through the SQL filter are ignored", async () => {
        const rows = [
            { session: "session:`s9`", name: "Bash", command_norm: "bun", input_json: JSON.stringify({ command: "+x" }) },
        ];
        const out = await Effect.runPromise(computeSessionLoc(["session:`s9`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s9`")).toEqual({ added: 0, removed: 0 });
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
