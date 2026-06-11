import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, FileSystem, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { scaffoldWorkspace } from "./sdk-workspace.ts";

const fsLayers = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const run = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(fsLayers)) as Effect.Effect<A, never>);

const mk = () => mkdtempSync(join(tmpdir(), "ax-hooks-ws-"));

describe("scaffoldWorkspace", () => {
    test("writes package.json with file: dep on sdkPath", async () => {
        const dir = mk();
        const sdkPath = "/abs/packages/hooks-sdk";
        await run(scaffoldWorkspace({ dir, sdkPath, install: false }));

        const pkgRaw = readFileSync(join(dir, "package.json"), "utf8");
        const pkg = JSON.parse(pkgRaw);
        expect(pkg.name).toBe("ax-hooks-workspace");
        expect(pkg.private).toBe(true);
        expect(pkg.type).toBe("module");
        expect(pkg.dependencies["@ax/hooks-sdk"]).toBe(`file:${sdkPath}`);
        // trailing newline
        expect(pkgRaw.endsWith("\n")).toBe(true);
    });

    test("writes both starter hook files", async () => {
        const dir = mk();
        const sdkPath = "/abs/packages/hooks-sdk";
        const written = await run(scaffoldWorkspace({ dir, sdkPath, install: false }));

        const ewPath = join(dir, "enforce-worktree.ts");
        const ewwPath = join(dir, "enforce-worktree-write.ts");
        expect(existsSync(ewPath)).toBe(true);
        expect(existsSync(ewwPath)).toBe(true);

        const ewContent = readFileSync(ewPath, "utf8");
        expect(ewContent).toContain('@ax/hooks-sdk/hooks/enforce-worktree');
        expect(ewContent).toContain('import { runMain }');
        expect(ewContent).toContain('export default hook');
        expect(ewContent).toContain('if (import.meta.main)');

        const ewwContent = readFileSync(ewwPath, "utf8");
        expect(ewwContent).toContain('@ax/hooks-sdk/hooks/enforce-worktree-write');

        // Both hook files should be in the written list
        expect(written).toContain(ewPath);
        expect(written).toContain(ewwPath);
    });

    test("does not overwrite an existing hook file (preserves user edits)", async () => {
        const dir = mk();
        const sdkPath = "/abs/packages/hooks-sdk";
        const ewPath = join(dir, "enforce-worktree.ts");

        // Pre-write a customized file
        writeFileSync(ewPath, "// my custom hook\nexport default null;\n");

        await run(scaffoldWorkspace({ dir, sdkPath, install: false }));

        // Content must be unchanged
        const content = readFileSync(ewPath, "utf8");
        expect(content).toBe("// my custom hook\nexport default null;\n");
    });

    test("re-running scaffold updates package.json but still skips existing hooks", async () => {
        const dir = mk();
        const sdkPath = "/abs/packages/hooks-sdk";

        // First scaffold
        await run(scaffoldWorkspace({ dir, sdkPath, install: false }));
        // Simulate user editing enforce-worktree-write.ts
        const ewwPath = join(dir, "enforce-worktree-write.ts");
        writeFileSync(ewwPath, "// user edited\n");

        // Second scaffold with different sdkPath
        const sdkPath2 = "/abs/packages/hooks-sdk-v2";
        const written2 = await run(scaffoldWorkspace({ dir, sdkPath: sdkPath2, install: false }));

        // package.json gets updated
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        expect(pkg.dependencies["@ax/hooks-sdk"]).toBe(`file:${sdkPath2}`);

        // eww file not in written list (skipped)
        expect(written2).not.toContain(ewwPath);
        // content preserved
        expect(readFileSync(ewwPath, "utf8")).toBe("// user edited\n");
    });

    test("returns written paths including package.json and new files", async () => {
        const dir = mk();
        const sdkPath = "/abs/packages/hooks-sdk";
        const written = await run(scaffoldWorkspace({ dir, sdkPath, install: false }));

        expect(written).toContain(join(dir, "package.json"));
        expect(written).toContain(join(dir, "enforce-worktree.ts"));
        expect(written).toContain(join(dir, "enforce-worktree-write.ts"));
        expect(written.length).toBe(3);
    });

    test("creates dir if it does not exist", async () => {
        const base = mk();
        const dir = join(base, "nested", "hooks");
        await run(scaffoldWorkspace({ dir, sdkPath: "/sdk", install: false }));
        expect(existsSync(join(dir, "package.json"))).toBe(true);
    });
});
