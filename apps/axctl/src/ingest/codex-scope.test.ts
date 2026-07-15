import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalCwdInRepoScope, cwdInRepoScope, codexCwdFromMetaLine } from "./codex-scope.ts";

describe("cwdInRepoScope", () => {
    const roots = ["/Users/x/Projects/ax"];

    test("keeps a session whose cwd IS the repo root", () => {
        expect(cwdInRepoScope("/Users/x/Projects/ax", roots)).toBe(true);
    });
    test("keeps a session inside the repo root", () => {
        expect(cwdInRepoScope("/Users/x/Projects/ax/apps/axctl", roots)).toBe(true);
    });
    test("EXCLUDES an out-of-repo rollout", () => {
        expect(cwdInRepoScope("/Users/x/Projects/other", roots)).toBe(false);
    });
    test("does not match a sibling with a shared prefix", () => {
        // /Users/x/Projects/ax-extra must NOT be considered inside /…/ax
        expect(cwdInRepoScope("/Users/x/Projects/ax-extra", roots)).toBe(false);
    });
    test("null cwd is out of scope", () => {
        expect(cwdInRepoScope(null, roots)).toBe(false);
    });
    test("tolerates trailing slashes on the root", () => {
        expect(cwdInRepoScope("/Users/x/Projects/ax/apps", ["/Users/x/Projects/ax/"])).toBe(true);
    });
});

describe("canonicalCwdInRepoScope (F4: realpath both sides)", () => {
    const run = (cwd: string | null, roots: readonly string[]) =>
        Effect.runPromise(
            canonicalCwdInRepoScope(cwd, roots).pipe(Effect.provide(BunFileSystem.layer)),
        );

    test("a symlinked in-repo cwd is INCLUDED after realpath", async () => {
        const base = mkdtempSync(join(tmpdir(), "ax-scope-"));
        const repo = join(base, "repo");
        mkdirSync(join(repo, "apps"), { recursive: true });
        const link = join(base, "repo-link");
        symlinkSync(repo, link); // link -> repo
        try {
            // Lexically, /base/repo-link/apps is NOT under /base/repo ...
            expect(cwdInRepoScope(join(link, "apps"), [repo])).toBe(false);
            // ... but canonicalizing resolves the symlink so it IS in scope.
            expect(await run(join(link, "apps"), [repo])).toBe(true);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    test("a `..` escape is EXCLUDED after canonicalization", async () => {
        const base = mkdtempSync(join(tmpdir(), "ax-scope-"));
        const repo = join(base, "repo");
        const outside = join(base, "outside");
        mkdirSync(repo, { recursive: true });
        mkdirSync(outside, { recursive: true });
        try {
            // /base/repo/../outside canonicalizes to /base/outside, out of scope.
            expect(await run(join(repo, "..", "outside"), [repo])).toBe(false);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    test("falls back to the raw path when realpath fails (vanished path)", async () => {
        // Neither path exists -> realpath fails -> lexical fallback still matches.
        const root = join(tmpdir(), "ax-scope-missing-root");
        expect(await run(join(root, "sub"), [root])).toBe(true);
    });

    test("null cwd is out of scope", async () => {
        expect(await run(null, ["/whatever"])).toBe(false);
    });
});

describe("codexCwdFromMetaLine", () => {
    test("extracts cwd from a session_meta line", () => {
        const line = JSON.stringify({
            type: "session_meta",
            payload: { id: "abc", cwd: "/Users/x/Projects/ax", cli_version: "1" },
        });
        expect(codexCwdFromMetaLine(line)).toBe("/Users/x/Projects/ax");
    });
    test("null for a non-session_meta line", () => {
        expect(codexCwdFromMetaLine(JSON.stringify({ type: "turn_context", payload: {} }))).toBeNull();
    });
    test("null for a session_meta line without cwd", () => {
        expect(codexCwdFromMetaLine(JSON.stringify({ type: "session_meta", payload: { id: "a" } }))).toBeNull();
    });
    test("null for malformed json", () => {
        expect(codexCwdFromMetaLine("{not json")).toBeNull();
        expect(codexCwdFromMetaLine("")).toBeNull();
    });
});
