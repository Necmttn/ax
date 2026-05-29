import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { GitKey, gitStage } from "./git.ts";

describe("gitStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(GitKey)("git")).toBe("git");
        expect(gitStage.meta.key).toBe("git");
        expect(gitStage.meta.deps).toEqual([]);
        expect(gitStage.meta.tags).toEqual(["ingest"]);
    });
});
