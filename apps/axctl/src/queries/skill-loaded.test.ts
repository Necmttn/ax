import { describe, expect, it } from "bun:test";
import { cacheReadResults, runWithCacheRead } from "../testing/cache-read.ts";
import { fetchSkillLoaded } from "./skill-loaded.ts";

const makeMockDb = cacheReadResults;
const run = runWithCacheRead;

describe("fetchSkillLoaded", () => {
    it("joins activation counts to skill names, sorts desc, respects limit", async () => {
        const rows = await run(
            fetchSkillLoaded({ limit: 2 }),
            makeMockDb([
                [
                    { sid: "skill:a", activations: 80 },
                    { sid: "skill:b", activations: 102 },
                    { sid: "skill:c", activations: 4 },
                ],
                [
                    { id: "skill:a", name: "a", content_hash: "ha" },
                    { id: "skill:b", name: "b", content_hash: "hb" },
                    { id: "skill:c", name: "c", content_hash: "hc" },
                ],
            ]),
        );
        expect(rows).toEqual([
            { name: "b", activations: 102 },
            { name: "a", activations: 80 },
        ]);
    });

    it("collapses plugin-namespace twins, sums activations, keeps bare name", async () => {
        const rows = await run(
            fetchSkillLoaded({ limit: 10 }),
            makeMockDb([
                [
                    { sid: "skill:bare", activations: 80 },
                    { sid: "skill:ns", activations: 80 },
                ],
                [
                    { id: "skill:bare", name: "image-to-code", content_hash: "h1" },
                    { id: "skill:ns", name: "necmttn:image-to-code", content_hash: "h1" },
                ],
            ]),
        );
        expect(rows).toEqual([{ name: "image-to-code", activations: 160 }]);
    });

    it("returns empty when no activations", async () => {
        const rows = await run(fetchSkillLoaded({ limit: 10 }), makeMockDb([[], []]));
        expect(rows).toEqual([]);
    });
});
