import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    claimDownloadSentinel,
    releaseDownloadSentinel,
    repoRootFrom,
    resolveTestDylib,
} from "./duckdb-dylib.ts";

describe("resolveTestDylib", () => {
    test("either resolves to a real file on disk or explains why it cannot", async () => {
        const found = await resolveTestDylib();
        if (found.ok) {
            expect(existsSync(found.path)).toBe(true);
        } else {
            expect(found.reason.length).toBeGreaterThan(0);
        }
    });

    test("honours AX_DUCKDB_DYLIB when it points at an existing file", async () => {
        const first = await resolveTestDylib();
        if (!first.ok) return; // nothing on disk to point at; covered by the test above
        const prev = process.env.AX_DUCKDB_DYLIB;
        process.env.AX_DUCKDB_DYLIB = first.path;
        try {
            const second = await resolveTestDylib();
            expect(second).toEqual({ ok: true, path: first.path });
        } finally {
            if (prev === undefined) delete process.env.AX_DUCKDB_DYLIB;
            else process.env.AX_DUCKDB_DYLIB = prev;
        }
    });
});

// Cross-review P3-4: parallel test processes shared ONE zip path and ONE
// extraction directory, so a second process could read a half-written
// archive or a half-extracted library. Downloads now run single-file behind
// an exclusive-create sentinel; everyone else waits for the result.
describe("download single-flight", () => {
    test("only the first caller claims the sentinel; a second call is told to wait", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-dylib-sentinel-"));
        try {
            const sentinel = join(dir, "download.lock");
            expect(claimDownloadSentinel(sentinel)).toBe("claimed");
            expect(claimDownloadSentinel(sentinel)).toBe("busy");
            releaseDownloadSentinel(sentinel);
            expect(claimDownloadSentinel(sentinel)).toBe("claimed");
            releaseDownloadSentinel(sentinel);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a sentinel left behind by a crashed process ages out instead of wedging every later run", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-dylib-sentinel-"));
        try {
            const sentinel = join(dir, "download.lock");
            expect(claimDownloadSentinel(sentinel)).toBe("claimed");
            const longAgo = new Date(Date.now() - 60 * 60_000);
            utimesSync(sentinel, longAgo, longAgo);
            expect(claimDownloadSentinel(sentinel)).toBe("claimed");
            releaseDownloadSentinel(sentinel);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("repoRootFrom", () => {
    test("reports failure instead of silently falling back when no turbo.json is found while walking up", () => {
        // /private/tmp -> /private -> / ; none of these hold a turbo.json,
        // so the walk exhausts and the failure must be observable, not a
        // silent process.cwd() fallback.
        const result = repoRootFrom("/private/tmp");
        expect(result.ok).toBe(false);
    });

    test("finds the repo root when turbo.json is present on the walk", () => {
        const result = repoRootFrom(import.meta.dir);
        expect(result).toEqual({ ok: true, dir: expect.any(String) });
        if (result.ok) {
            expect(existsSync(`${result.dir}/turbo.json`)).toBe(true);
        }
    });
});
