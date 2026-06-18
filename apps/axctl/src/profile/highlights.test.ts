import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    decodeHighlightsFile,
    HighlightsInvalidError,
    loadHighlightsBlock,
    saveHighlightsFile,
} from "./highlights.ts";

const tmpPath = () => `/tmp/ax-highlights-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`;

describe("highlights file loader", () => {
    test("decodeHighlightsFile accepts a valid file", async () => {
        const v = await Effect.runPromise(decodeHighlightsFile({
            v: 1, authored_at: "2026-06-17T00:00:00Z", taste: "ship clean",
        }));
        expect(v.v).toBe(1);
        expect(v.taste).toBe("ship clean");
    });

    test("decodeHighlightsFile rejects a missing v", async () => {
        const exit = await Effect.runPromiseExit(decodeHighlightsFile({ authored_at: "x" }));
        expect(exit._tag).toBe("Failure");
    });

    test("saveHighlightsFile then loadHighlightsBlock round-trips minus v", async () => {
        const path = tmpPath();
        await saveHighlightsFile(path, {
            v: 1, authored_at: "2026-06-17T00:00:00Z",
            setup: [{ title: "loader", what: "w", why: "y" }],
        });
        const block = await loadHighlightsBlock(path);
        expect(block?.setup?.[0]?.title).toBe("loader");
        expect((block as Record<string, unknown>).v).toBeUndefined();
        await Bun.spawnSync(["rm", "-f", path]);
    });

    test("loadHighlightsBlock returns null for a missing file", async () => {
        expect(await loadHighlightsBlock(tmpPath())).toBeNull();
    });

    test("loadHighlightsBlock THROWS for corrupt JSON (missing != invalid)", async () => {
        const path = tmpPath();
        await Bun.write(path, "{not json");
        await expect(loadHighlightsBlock(path)).rejects.toBeInstanceOf(HighlightsInvalidError);
        await Bun.spawnSync(["rm", "-f", path]);
    });

    test("loadHighlightsBlock THROWS for valid JSON that fails the schema", async () => {
        const path = tmpPath();
        // wins[].text is required; a number violates the schema.
        await Bun.write(path, JSON.stringify({ v: 1, authored_at: "x", wins: [{ text: 5 }] }));
        await expect(loadHighlightsBlock(path)).rejects.toBeInstanceOf(HighlightsInvalidError);
        await Bun.spawnSync(["rm", "-f", path]);
    });
});
