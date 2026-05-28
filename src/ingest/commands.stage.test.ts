import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { CommandsKey, commandsStage } from "./commands.ts";

describe("commandsStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(CommandsKey)("commands")).toBe("commands");
        expect(commandsStage.meta.key).toBe("commands");
        expect(commandsStage.meta.deps).toEqual([]);
        expect(commandsStage.meta.tags).toEqual(["ingest"]);
    });
});
