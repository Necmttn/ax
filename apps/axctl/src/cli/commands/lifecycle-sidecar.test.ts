import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { cacheReadTestLayer, judgmentTestLayer } from "../../testing/judgment-test-layer.ts";
import { collectSidecarDoctorCheck } from "./lifecycle.ts";

describe("doctor sidecar integrity boundary", () => {
    test("reports a dangling sidecar reference through the production check", async () => {
        const result = await Effect.runPromise(collectSidecarDoctorCheck.pipe(
            Effect.provide(Layer.merge(
                judgmentTestLayer((sql) => sql.includes('FROM "plays_role"')
                    ? [{ id: "tag-1", target: "skill:missing" }]
                    : []),
                cacheReadTestLayer(() => []),
            )),
        ));
        expect(result).toEqual({
            name: "sidecar-refs",
            ok: false,
            detail: "1 of 1 cache reference(s) dangling",
        });
    });
});
