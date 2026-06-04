import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { formatClassifierList, listClassifiers } from "./list.ts";

// listClassifiers reads fixture files via @effect/platform FileSystem; provide
// the REAL Bun-backed layers (forced-dependency edit, never a mock).
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("classifier list", () => {
    test("includes registered classifiers with fixture counts", async () => {
        const rows = await run(listClassifiers().pipe(Effect.provide(BunFsLayer)));
        const verification = rows.find((row) => row.key === "verification-event");
        const direction = rows.find((row) => row.key === "direction-event");

        expect(rows.map((row) => row.key)).toEqual(expect.arrayContaining([
            "reaction-event",
            "direction-event",
            "correction-event",
            "verification-event",
        ]));
        expect(verification?.fixtureCases).toBe(6);
        expect(verification?.source).toBe("package");
        expect(verification?.packageName).toBe("@ax-classifier/verification-event");
        expect(direction?.fixtureCases).toBe(8);
        expect(direction?.source).toBe("package");
        expect(direction?.packageName).toBe("@ax-classifier/direction-event");
        expect(rows.filter((row) => !["verification-event", "direction-event"].includes(row.key)).every((row) => row.source === "built-in")).toBe(true);
    });

    test("formats a compact table", async () => {
        const rows = await run(listClassifiers().pipe(Effect.provide(BunFsLayer)));
        const output = formatClassifierList(rows);

        expect(output).toContain("classifier");
        expect(output).toContain("verification-event");
        expect(output).toContain("verification_request -> test_required,output_required,regression_guard");
    });
});
