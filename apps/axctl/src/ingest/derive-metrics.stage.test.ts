import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DeriveMetricsKey, deriveMetricsStage } from "./derive-metrics.ts";

describe("derive-metrics stage", () => {
    test("key + meta", () => {
        expect(Schema.decodeUnknownSync(DeriveMetricsKey)("derive-metrics")).toBe("derive-metrics");
        expect(deriveMetricsStage.meta.key).toBe("derive-metrics");
        expect(deriveMetricsStage.meta.deps).toEqual(["git", "github-pr", "session-health", "spawned"]);
        expect(deriveMetricsStage.meta.tags).toEqual(["derive"]);
    });
});
