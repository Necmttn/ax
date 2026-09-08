import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveVerificationChecks } from "./verify.ts";
import type { PackageInfo, ProjectStack } from "./types.ts";

const pkg = (dir: string | null, scripts: Record<string, string> = {}, manager: string | null = "npm"): PackageInfo => ({
    packageJsonPath: dir ? `${dir}/package.json` : null, packageManager: manager,
    scripts, dependencies: [], devDependencies: [],
});
const checks = (root: string, paths: string[], stack: ProjectStack) => deriveVerificationChecks({
    git: { root, cwd: root, branch: "main", head: "abc", dirty: true,
        changes: paths.map(path => ({ path, status: "M", staged: false, unstaged: true, untracked: false, lang: null })) },
    stack,
});
const stack = (root: PackageInfo, packages: PackageInfo[]): ProjectStack => ({ package: root, packages, signals: [], instructions: [] });

describe("verification command boundaries", () => {
    test("selects a nested package without a root manifest", () => {
        const result = checks("/repo", ["frontend/a.ts"], stack(pkg(null), [pkg("/repo/frontend", { typecheck: "tsc" })]));
        expect(result[0]).toMatchObject({ id: "typescript-typecheck:frontend", command: "npm --prefix frontend run typecheck" });
    });
    test("recommends tests for each source package without a root test script", () => {
        const result = checks("/repo", ["frontend/a.ts", "backend/b.ts"], stack(pkg("/repo"), [
            pkg("/repo/frontend", { test: "vitest" }), pkg("/repo/backend", { test: "vitest" }),
        ]));
        expect(result.filter(c => c.id.startsWith("tests-consider")).map(c => [c.command, c.relatedFiles])).toEqual([
            ["npm --prefix frontend run test", ["frontend/a.ts"]], ["npm --prefix backend run test", ["backend/b.ts"]],
        ]);
    });
    test("a test edit in one package does not suppress source tests in another", () => {
        const result = checks("/repo", ["frontend/a.test.ts", "backend/b.ts"], stack(pkg("/repo"), [
            pkg("/repo/frontend", { test: "vitest" }), pkg("/repo/backend", { test: "vitest" }),
        ]));
        expect(result.find(c => c.id === "tests-consider:backend")?.command).toBe("npm --prefix backend run test");
    });
    test("unknown package managers and missing test runners produce no executable guess", () => {
        for (const manager of ["unknown", "npm-malicious", null]) {
            const result = checks("/repo", ["a.test.ts"], stack(pkg("/repo", { typecheck: "tsc" }, manager), []));
            expect(result.every(c => c.command === null)).toBe(true);
        }
        const result = checks("/repo", ["a.test.ts"], stack(pkg("/repo"), []));
        expect(result.find(c => c.id === "tests-run")?.command).toBeNull();
    });
    test("ignores paths outside the repository", () => {
        const result = checks("/repo", ["../outside/a.ts", "/outside/b.ts", "C:\\outside\\c.ts"], stack(pkg("/repo", {typecheck:"tsc"}), []));
        expect(result.some(c => c.id.startsWith("typescript-typecheck"))).toBe(false);
    });
    test("Bun binary lockfiles satisfy the lockfile check", () => {
        const result = checks("/repo", ["package.json", "bun.lockb"], stack(pkg("/repo", {}, "bun"), []));
        expect(result.some(c => c.id === "package-lockfile")).toBe(false);
    });
    test("shell commands preserve hostile directory names and use the package working directory", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "ax-verify-security-")));
        try {
            for (const manager of ["npm", "pnpm", "yarn", "bun"]) {
                const name = "-web ' $(touch INJECTED); app";
                const dir = join(root, name);
                await mkdir(dir, { recursive: true });
                const bin = join(root, "bin");
                await mkdir(bin, { recursive: true });
                // Stub only the package manager; the real shell parses the generated command.
                await writeFile(join(bin, manager), '#!/bin/sh\nif [ "$1" = "--prefix" ]; then cd "$2" || exit 2; fi\npwd\n', { mode: 0o755 });
                const result = checks(root, [`${name}/a.ts`], stack(pkg(root), [pkg(dir, {typecheck:"tsc"}, manager)]));
                const output = Bun.spawnSync(["/bin/sh", "-c", result[0]!.command!], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
                expect(output.exitCode).toBe(0);
                expect(output.stdout.toString().trim()).toBe(dir);
                expect(await Bun.file(join(root, "INJECTED")).exists()).toBe(false);
            }
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    test("uses a hoisted compiler while keeping the nested working directory", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "ax-verify-hoisted-")));
        try {
            const dir = join(root, "frontend");
            await mkdir(dir);
            await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
            await writeFile(join(root, "node_modules", ".bin", "tsc"), '#!/bin/sh\npwd\n', { mode: 0o755 });
            const info = { ...pkg(dir), devDependencies: ["typescript"] };
            const result = checks(root, ["frontend/a.ts"], stack(pkg(root), [info]));
            const output = Bun.spawnSync(["/bin/sh", "-c", result[0]!.command!], { cwd: root });
            expect(output.exitCode).toBe(0);
            expect(output.stdout.toString().trim()).toBe(dir);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    test("npm fallback runs the compiler from the nested package", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "ax-verify-npm-")));
        try {
            const dir = join(root, "frontend");
            await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
            await writeFile(join(dir, "node_modules", ".bin", "tsc"), '#!/bin/sh\npwd\n', { mode: 0o755 });
            const info = { ...pkg(dir), devDependencies: ["typescript"] };
            const result = checks(root, ["frontend/a.ts"], stack(pkg(root), [info]));
            const output = Bun.spawnSync(["/bin/sh", "-c", result[0]!.command!], { cwd: root });
            expect(output.exitCode).toBe(0);
            expect(output.stdout.toString().trim()).toBe(dir);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
