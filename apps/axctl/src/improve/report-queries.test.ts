import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import { listProposalsCreatedSince, listVerdictsLockedSince } from "./report-queries.ts";

// Fake-client harness (mirrors improve/show.test.ts): each yielded query()
// returns the next fixture wrapped as a one-element result tuple.
const layerWith = (...fixtures: unknown[][]) => {
    let i = 0;
    return judgmentTestLayer(() => fixtures[i++] ?? []);
};

describe("listProposalsCreatedSince", () => {
    test("maps rows to {id, title, form, dedupe_sig}", async () => {
        const layer = layerWith([
            { id: "proposal:p1", title: "Guard merges", form: "hook", dedupe_sig: "guard-merges", created_at: new Date("2026-06-13T01:00:00Z") },
        ]);
        const rows = await Effect.runPromise(
            listProposalsCreatedSince(new Date("2026-06-13T00:00:00Z")).pipe(Effect.provide(layer)),
        );
        expect(rows[0]).toMatchObject({ id: "proposal:p1", title: "Guard merges", form: "hook", dedupe_sig: "guard-merges" });
    });

    test("empty result -> []", async () => {
        const rows = await Effect.runPromise(
            listProposalsCreatedSince(new Date("2026-06-13T00:00:00Z")).pipe(Effect.provide(layerWith([]))),
        );
        expect(rows).toEqual([]);
    });
});

describe("listVerdictsLockedSince", () => {
    test("maps rows to {verdict, title, sig}", async () => {
        const layer = layerWith([
            { verdict: "confirmed", title: "Stop bare bun test", sig: "stop-bare-bun", observed_at: new Date("2026-06-13T01:00:00Z") },
        ]);
        const rows = await Effect.runPromise(
            listVerdictsLockedSince(new Date("2026-06-13T00:00:00Z")).pipe(Effect.provide(layer)),
        );
        expect(rows[0]).toMatchObject({ verdict: "confirmed", title: "Stop bare bun test", sig: "stop-bare-bun" });
    });

    test("empty result -> []", async () => {
        const rows = await Effect.runPromise(
            listVerdictsLockedSince(new Date("2026-06-13T00:00:00Z")).pipe(Effect.provide(layerWith([]))),
        );
        expect(rows).toEqual([]);
    });
});
