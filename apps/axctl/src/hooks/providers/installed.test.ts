import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import { posixPath } from "@ax/lib/shared/path";
import { HOME } from "@ax/lib/paths";
import { claudeProvider } from "./claude.ts";
import { codexProvider } from "./codex.ts";
import { cursorProvider } from "./cursor.ts";
import { opencodeProvider } from "./opencode.ts";

// Each provider's `installed` probes a global config dir via FileSystem.exists,
// recovered to `false` on any PlatformError. We drive it through
// `layerTestFileSystem`: a path is "present" when a seeded key sits under it
// (the test FS treats a strict prefix as a directory).

const run = (
    eff: Effect.Effect<boolean, never, import("effect").FileSystem.FileSystem>,
    files: Record<string, string>,
): Promise<boolean> =>
    Effect.runPromise(eff.pipe(Effect.provide(layerTestFileSystem(files))));

describe("hook provider installed()", () => {
    test("claude: true when ~/.claude exists, false when absent", async () => {
        const probe = posixPath.join(HOME, ".claude");
        expect(await run(claudeProvider.installed(null), { [`${probe}/settings.json`]: "{}" })).toBe(true);
        expect(await run(claudeProvider.installed(null), {})).toBe(false);
    });

    test("codex: true when ~/.codex exists, false when absent", async () => {
        const probe = posixPath.join(HOME, ".codex");
        expect(await run(codexProvider.installed(null), { [`${probe}/hooks.json`]: "{}" })).toBe(true);
        expect(await run(codexProvider.installed(null), {})).toBe(false);
    });

    test("cursor: true when ~/.cursor exists, false when absent", async () => {
        const probe = posixPath.join(HOME, ".cursor");
        expect(await run(cursorProvider.installed(null), { [`${probe}/hooks.json`]: "{}" })).toBe(true);
        expect(await run(cursorProvider.installed(null), {})).toBe(false);
    });

    test("opencode: true when ~/.config/opencode exists, false when absent", async () => {
        const probe = posixPath.join(HOME, ".config", "opencode");
        expect(await run(opencodeProvider.installed(null), { [`${probe}/opencode.json`]: "{}" })).toBe(true);
        expect(await run(opencodeProvider.installed(null), {})).toBe(false);
    });
});
