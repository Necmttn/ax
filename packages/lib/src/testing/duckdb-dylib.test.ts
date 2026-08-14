import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { repoRootFrom, resolveTestDylib } from "./duckdb-dylib.ts";

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
