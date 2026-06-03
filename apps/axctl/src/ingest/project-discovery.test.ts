import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { Effect, Layer } from "effect";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import { BunPath } from "@effect/platform-bun";
import { discoverProjectRoots } from "./project-discovery.ts";

// `PROJECTS_DIR` is hardcoded to `~/.claude/projects`, so the in-memory FS is
// seeded at that exact path. The slug `-tmp-axproj-fixture` naive-decodes to
// `/tmp/axproj/fixture`; seeding a marker key under it makes the mock's `stat`
// report that path as a Directory, so the naive-decode branch resolves without
// touching the (un-mockable) Bun partial-read fallback.
const PROJECTS_DIR = `${homedir()}/.claude/projects`;

const run = (files: Record<string, string>) =>
    Effect.runPromise(
        discoverProjectRoots().pipe(
            Effect.provide(
                Layer.merge(layerTestFileSystem(files), BunPath.layer),
            ),
        ),
    );

describe("discoverProjectRoots", () => {
    test("resolves a naive-decodable slug to its repo root", async () => {
        const roots = await run({
            [`${PROJECTS_DIR}/-tmp-axproj-fixture/session.jsonl`]: "{}",
            "/tmp/axproj/fixture/marker": "x",
        });
        expect(roots).toEqual([{ name: "fixture", path: "/tmp/axproj/fixture" }]);
    });

    test("missing projects dir → empty list, no defect", async () => {
        const roots = await run({});
        expect(roots).toEqual([]);
    });

    test("skips a slug whose naive-decoded path is not a real directory", async () => {
        // The slug lists, but the decoded path `/tmp/axproj/ghost` has no
        // marker key so the mock's `stat` reports NotFound (not a Directory).
        // peekFirstCwd then runs the Bun partial-read, which finds no real file
        // and yields null → the slug is dropped.
        const roots = await run({
            [`${PROJECTS_DIR}/-tmp-axproj-ghost/session.jsonl`]: "{}",
        });
        expect(roots).toEqual([]);
    });
});
