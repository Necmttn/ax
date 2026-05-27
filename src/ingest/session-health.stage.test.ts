import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { SessionHealthKey, SessionHealthStageStats, sessionHealthStage } from "./session-health.ts";

describe("sessionHealthStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(SessionHealthKey)("session-health")).toBe("session-health");
        expect(sessionHealthStage.meta.key).toBe("session-health");
        expect(sessionHealthStage.meta.deps).toEqual(["signals"]);
        expect(sessionHealthStage.meta.tags).toEqual(["derive", "health"]);
    });
});
