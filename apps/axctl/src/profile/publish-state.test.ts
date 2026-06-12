import { afterEach, describe, expect, test } from "bun:test";
import { loadPublishState, savePublishState, type PublishState } from "./publish-state.ts";

const dir = `/tmp/ax-publish-state-test-${process.pid}`;
const path = `${dir}/profile-publish.json`;

afterEach(async () => {
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

const state: PublishState = {
    v: 1,
    gist_id: "abc123",
    owner: "necmttn",
    consented_at: "2026-06-12T19:00:00Z",
    published_at: "2026-06-12T19:00:00Z",
    no_cost: false,
};

describe("publish state", () => {
    test("round-trips", async () => {
        await savePublishState(path, state);
        expect(await loadPublishState(path)).toEqual(state);
    });

    test("missing file -> null", async () => {
        expect(await loadPublishState(`${dir}/nope.json`)).toBeNull();
    });

    test("corrupt file -> null (never throws)", async () => {
        await Bun.write(path, "{not json");
        expect(await loadPublishState(path)).toBeNull();
    });

    test("wrong shape -> null", async () => {
        await Bun.write(path, JSON.stringify({ v: 99 }));
        expect(await loadPublishState(path)).toBeNull();
    });
});
