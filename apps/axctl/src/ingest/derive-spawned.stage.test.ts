import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { SpawnedKey, spawnedStage } from "./derive-spawned.ts";

describe("spawnedStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(SpawnedKey)("spawned")).toBe("spawned");
        expect(spawnedStage.meta.key).toBe("spawned");
        expect(spawnedStage.meta.deps).toEqual(["claude", "codex"]);
        expect(spawnedStage.meta.tags).toEqual(["derive"]);
    });
});
