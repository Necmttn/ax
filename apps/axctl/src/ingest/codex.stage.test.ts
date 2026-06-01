import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { CodexKey, codexStage } from "./codex.ts";

describe("codexStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(CodexKey)("codex")).toBe("codex");
        expect(codexStage.meta.key).toBe("codex");
        expect(codexStage.meta.deps).toEqual(["skills", "commands"]);
        expect(codexStage.meta.tags).toEqual(["ingest"]);
    });
});
