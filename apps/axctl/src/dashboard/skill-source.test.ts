import { describe, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { FileSystem, Path } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { applySkillDecisionToDisk, readSkillSource } from "./skill-source.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("skill-source", { requireFts: true });
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

/** Write a real SKILL.md under a fresh temp dir, return the dir path. */
const writeSkillDir = (name: string, frontmatter: string, body: string) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectory({ prefix: `ax-skill-source-${name}-` });
        yield* fs.writeFileString(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
        return dir;
    });

describe("readSkillSource", () => {
    dtest("reads frontmatter + body for a user-scope skill on disk", async () => {
        const skillDir = await Effect.runPromise(writeSkillDir("tdd", "name: tdd", "Body text.").pipe(Effect.provide(BunFsLayer)));

        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skill-source-"), dylibPath, (w: CacheWriteService) =>
                w.putMany("skill", [
                    { id: "sk-tdd", name: "tdd", scope: "user", dir_path: skillDir, content_hash: "h1" },
                ]),
            ),
        );

        const payload = await readThroughFixture(
            fixture,
            dylibPath,
            readSkillSource("tdd").pipe(Effect.provide(BunFsLayer)),
        );

        expect(payload.state).toBe("active");
        expect(payload.frontmatter).toBe("name: tdd");
        expect(payload.body).toBe("Body text.");
        expect(payload.editable).toBe(true);
        expect(payload.error).toBeNull();
    });

    dtest("a plugin-scope skill is not editable even when present on disk", async () => {
        const skillDir = await Effect.runPromise(writeSkillDir("plugin-skill", "name: plugin-skill", "x").pipe(Effect.provide(BunFsLayer)));

        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skill-source-plugin-"), dylibPath, (w: CacheWriteService) =>
                w.putMany("skill", [
                    { id: "sk-plugin", name: "plugin-skill", scope: "plugin:foo", dir_path: skillDir, content_hash: "h1" },
                ]),
            ),
        );

        const payload = await readThroughFixture(
            fixture,
            dylibPath,
            readSkillSource("plugin-skill").pipe(Effect.provide(BunFsLayer)),
        );

        expect(payload.editable).toBe(false);
        expect(payload.state).toBe("active");
    });

    dtest("a synthetic (dir_path null) skill is reported missing/non-editable", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skill-source-synthetic-"), dylibPath, (w: CacheWriteService) =>
                w.putMany("skill", [
                    { id: "sk-codex-exec", name: "codex:exec_command", scope: "user", dir_path: "(synthetic)", content_hash: "h1" },
                ]),
            ),
        );

        const payload = await readThroughFixture(
            fixture,
            dylibPath,
            readSkillSource("codex:exec_command").pipe(Effect.provide(BunFsLayer)),
        );

        expect(payload.state).toBe("missing");
        expect(payload.editable).toBe(false);
    });

    dtest("an unknown skill name reports missing with an error message", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-skill-source-unknown-"), dylibPath, () => Effect.void));

        const payload = await readThroughFixture(
            fixture,
            dylibPath,
            readSkillSource("does-not-exist").pipe(Effect.provide(BunFsLayer)),
        );

        expect(payload.state).toBe("missing");
        expect(payload.error).toContain("no skill named");
    });
});

describe("applySkillDecisionToDisk", () => {
    dtest("archive renames SKILL.md to SKILL.md.archived for a user-scope skill", async () => {
        const skillDir = await Effect.runPromise(writeSkillDir("archive-me", "name: archive-me", "x").pipe(Effect.provide(BunFsLayer)));

        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skill-source-archive-"), dylibPath, (w: CacheWriteService) =>
                w.putMany("skill", [
                    { id: "sk-archive", name: "archive-me", scope: "user", dir_path: skillDir, content_hash: "h1" },
                ]),
            ),
        );

        const state = await readThroughFixture(
            fixture,
            dylibPath,
            applySkillDecisionToDisk("archive-me", "archive").pipe(Effect.provide(BunFsLayer)),
        );

        expect(state).toBe("disabled");

        const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(BunFsLayer)));
        const path = await Effect.runPromise(Path.Path.pipe(Effect.provide(BunFsLayer)));
        expect(await Effect.runPromise(fs.exists(path.join(skillDir, "SKILL.md.archived")))).toBe(true);
        expect(await Effect.runPromise(fs.exists(path.join(skillDir, "SKILL.md")))).toBe(false);
    });

    dtest("no-op (null) for a non-editable plugin-scope skill", async () => {
        const skillDir = await Effect.runPromise(writeSkillDir("plugin-noop", "name: plugin-noop", "x").pipe(Effect.provide(BunFsLayer)));

        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skill-source-plugin-noop-"), dylibPath, (w: CacheWriteService) =>
                w.putMany("skill", [
                    { id: "sk-plugin-noop", name: "plugin-noop", scope: "plugin:foo", dir_path: skillDir, content_hash: "h1" },
                ]),
            ),
        );

        const state = await readThroughFixture(
            fixture,
            dylibPath,
            applySkillDecisionToDisk("plugin-noop", "archive").pipe(Effect.provide(BunFsLayer)),
        );

        expect(state).toBeNull();
    });
});
