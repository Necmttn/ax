import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __testDiscoverClaudeSubagents,
    SubagentsKey,
    subagentsStage,
} from "./derive-claude-subagents.ts";

const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const discover = (root: string) =>
    Effect.runPromise(__testDiscoverClaudeSubagents(root).pipe(Effect.provide(BunFsLayer)));

describe("subagentsStage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(SubagentsKey)("subagents")).toBe("subagents");
        expect(subagentsStage.meta.key).toBe("subagents");
        expect(subagentsStage.meta.deps).toEqual(["claude", "codex"]);
        expect(subagentsStage.meta.tags).toEqual(["derive"]);
    });

    it("accepts a missing optional transcript root", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-subagent-missing-root-"));
        expect(await discover(join(base, "missing"))).toEqual([]);
    });

    it("reports a regular file transcript root", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-subagent-file-root-"));
        const root = join(base, "not-a-directory");
        await writeFile(root, "data");

        const error = await Effect.runPromise(
            Effect.flip(__testDiscoverClaudeSubagents(root).pipe(Effect.provide(BunFsLayer))),
        );
        expect(error.reason._tag).not.toBe("NotFound");
    });
});
