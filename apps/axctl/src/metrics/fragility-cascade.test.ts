import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeFragilityCascade, type CascadeEdge } from "./fragility-cascade.ts";
import { SurrealClient } from "@ax/lib/db";

// Three bounded queries: route by FROM touched / FROM produced / FROM edited.
const db = (
    touched: Array<Record<string, unknown>>,
    produced: Array<Record<string, unknown>>,
    edited: Array<Record<string, unknown>>,
) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/FROM touched/.test(sql)) return Effect.succeed([touched] as unknown as T);
            if (/FROM produced/.test(sql)) return Effect.succeed([produced] as unknown as T);
            if (/FROM edited/.test(sql)) return Effect.succeed([edited] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";

describe("computeFragilityCascade", () => {
    test("origin→downstream edges weighted by distinct downstream fixers", async () => {
        const touched = [
            { commit: "commit:`C`", file: "file:`f1`", ts: T0 },
            { commit: "commit:`C`", file: "file:`f2`", ts: T0 },
        ];
        const produced = [{ commit: "commit:`C`", session: "session:`A`" }];
        const edited = [
            { file: "file:`f1`", session: "session:`B`", ts: T1 },
            { file: "file:`f2`", session: "session:`B`", ts: T1 }, // same pair, 2nd file
            { file: "file:`f1`", session: "session:`C`", ts: T1 },
        ];
        const edges = await Effect.runPromise(
            computeFragilityCascade().pipe(Effect.provide(db(touched, produced, edited))),
        );
        const a = edges.filter((e: CascadeEdge) => e.origin === "session:`A`");
        expect(new Set(a.map((e) => e.downstream))).toEqual(new Set(["session:`B`", "session:`C`"]));
        expect(a.length).toBe(2); // deduped to distinct (origin,downstream) pairs
        expect(a.every((e) => e.weight === 2)).toBe(true); // distinct downstreams {B,C}=2
    });

    test("excludes the origin's own later edits and edits at/before the touch ts", async () => {
        const touched = [{ commit: "commit:`C`", file: "file:`f1`", ts: T1 }];
        const produced = [{ commit: "commit:`C`", session: "session:`A`" }];
        const edited = [
            { file: "file:`f1`", session: "session:`A`", ts: "2026-01-03T00:00:00Z" }, // origin itself → excluded
            { file: "file:`f1`", session: "session:`B`", ts: T0 }, // before touch ts → excluded
            { file: "file:`f1`", session: "session:`B`", ts: T1 }, // at touch ts (<=) → excluded
        ];
        const edges = await Effect.runPromise(
            computeFragilityCascade().pipe(Effect.provide(db(touched, produced, edited))),
        );
        expect(edges).toEqual([]);
    });

    test("no reverted-touched files → no edges (and no produced/edited query needed)", async () => {
        const edges = await Effect.runPromise(computeFragilityCascade().pipe(Effect.provide(db([], [], []))));
        expect(edges).toEqual([]);
    });
});
