import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { axProfileRuntime, cmdProfileInterviewSubmit } from "./profile.ts";
import { resolveRuntime } from "./manifest.ts";
import { loadHighlightsBlock } from "../../profile/highlights.ts";

const tmpPath = () => `/tmp/ax-hl-submit-${process.pid}-${Math.random().toString(36).slice(2)}.json`;

describe("ax profile interview submit", () => {
    test("validates JSON and writes the highlights file", async () => {
        const path = tmpPath();
        const json = JSON.stringify({ v: 1, authored_at: "2026-06-17T00:00:00Z", taste: "ship clean" });
        await Effect.runPromise(cmdProfileInterviewSubmit({ rawJson: json, path }));
        const block = await loadHighlightsBlock(path);
        expect(block?.taste).toBe("ship clean");
        Bun.spawnSync(["rm", "-f", path]);
    });

    test("fails on a bad shape and does not write", async () => {
        const path = tmpPath();
        const exit = await Effect.runPromiseExit(
            cmdProfileInterviewSubmit({ rawJson: JSON.stringify({ taste: 5 }), path }),
        );
        expect(exit._tag).toBe("Failure");
        expect(await Bun.file(path).exists()).toBe(false);
    });

    test("routes `interview submit` to the no-DB runtime; other paths stay db", () => {
        const entry = axProfileRuntime.profile;
        // submit only writes a local file - must not require a live SurrealDB.
        expect(resolveRuntime(entry, ["profile", "interview", "submit"])).toBe("none");
        // brief generation reads the rig; show/publish read the graph.
        expect(resolveRuntime(entry, ["profile", "interview"])).toBe("db");
        expect(resolveRuntime(entry, ["profile", "show"])).toBe("db");
        expect(resolveRuntime(entry, ["profile", "publish"])).toBe("db");
    });
});
