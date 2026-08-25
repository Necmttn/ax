import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    claimDownloadSentinel,
    libFileName,
    releaseDownloadSentinel,
    decideFtsGate,
    probeFtsCapable,
    REAL_DUCKDB_TEST_TIMEOUT_MS,
    repoRootFrom,
    requireFtsFromEnv,
    resolveTestDylib,
    vendorDir,
    withRealDuckDbTimeout,
} from "./duckdb-dylib.ts";

describe("real DuckDB test timeout", () => {
    test("adds the real-database limit when a case has no explicit limit", () => {
        let received: number | object | undefined;
        const dtest = withRealDuckDbTimeout((_label, _fn, options) => {
            received = options;
        });

        dtest("case", () => undefined);

        expect(received).toBe(REAL_DUCKDB_TEST_TIMEOUT_MS);
    });

    test("preserves an explicit numeric or object limit", () => {
        const received: Array<number | object | undefined> = [];
        const dtest = withRealDuckDbTimeout((_label, _fn, options) => {
            received.push(options);
        });
        const options = { timeout: 12_000, retry: 1 };

        dtest("numeric", () => undefined, 15_000);
        dtest("object", () => undefined, options);

        expect(received).toEqual([15_000, options]);
    });
});

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

describe("custom-build priority", () => {
    test("prefers the custom-built artifact over the vendored download", async () => {
        const root = repoRootFrom(import.meta.dir);
        if (!root.ok) throw new Error("expected to find the repo root from the test file's location");

        // Prove a WIN over an existing vendor copy, not just its absence.
        // Never overwrite real vendor bytes: only create a fake vendor file
        // when one is not already there, and only remove what we created.
        const vendorFile = join(vendorDir(root.dir), libFileName());
        const vendorAlreadyExisted = existsSync(vendorFile);
        if (!vendorAlreadyExisted) {
            mkdirSync(vendorDir(root.dir), { recursive: true });
            writeFileSync(vendorFile, "fake-vendor-dylib-for-priority-test");
        }

        const distDir = mkdtempSync(join(tmpdir(), "ax-duckdb-dist-"));
        const customFile = join(distDir, libFileName());
        writeFileSync(customFile, "fake-custom-dylib-for-priority-test");

        const prevDylib = process.env.AX_DUCKDB_DYLIB;
        const prevDist = process.env.DUCKDB_DIST_DIR;
        delete process.env.AX_DUCKDB_DYLIB;
        process.env.DUCKDB_DIST_DIR = distDir;
        try {
            const found = await resolveTestDylib();
            expect(found).toEqual({ ok: true, path: customFile });
        } finally {
            if (prevDylib === undefined) delete process.env.AX_DUCKDB_DYLIB;
            else process.env.AX_DUCKDB_DYLIB = prevDylib;
            if (prevDist === undefined) delete process.env.DUCKDB_DIST_DIR;
            else process.env.DUCKDB_DIST_DIR = prevDist;
            rmSync(distDir, { recursive: true, force: true });
            if (!vendorAlreadyExisted) rmSync(vendorFile, { force: true });
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

// The 36-failure incident (PR #798): CI had no DuckDB, `resolveTestDylib`
// downloaded the UPSTREAM artifact - which cannot `LOAD fts` - and every
// FTS-dependent suite died on an extension error that read like a product bug.
// Capability is a separate question from availability, so it gets its own
// answer and its own policy.
describe("FTS capability gate", () => {
    test("a capable dylib just runs", () => {
        expect(decideFtsGate({ ok: true }, true)).toEqual({ mode: "run" });
        expect(decideFtsGate({ ok: true }, false)).toEqual({ mode: "run" });
    });

    test("under the CI flag an incapable dylib FAILS - it must never skip to green", () => {
        const gate = decideFtsGate({ ok: false, reason: "Extension \"fts\" not found" }, true);
        expect(gate.mode).toBe("fail");
    });

    test("without the flag it skips, so a contributor is not forced into an hour-long build", () => {
        const gate = decideFtsGate({ ok: false, reason: "nope" }, false);
        expect(gate.mode).toBe("skip");
    });

    test("either way the message says how to FIX it, and carries the original reason", () => {
        const reason = "Extension \"fts\" is an existing extension.";
        for (const required of [true, false]) {
            const gate = decideFtsGate({ ok: false, reason }, required);
            if (gate.mode === "run") throw new Error("expected a gated verdict");
            expect(gate.message).toContain(reason);
            expect(gate.message).toContain("scripts/build-duckdb.sh");
            expect(gate.message).toContain("DUCKDB_DIST_DIR");
        }
    });
});

describe("requireFtsFromEnv", () => {
    test("unset, empty, 0 and false all mean not required", () => {
        expect(requireFtsFromEnv({})).toBe(false);
        expect(requireFtsFromEnv({ AX_DUCKDB_REQUIRE_FTS: "" })).toBe(false);
        expect(requireFtsFromEnv({ AX_DUCKDB_REQUIRE_FTS: "  " })).toBe(false);
        // A workflow that sets the flag OFF must not read as on.
        expect(requireFtsFromEnv({ AX_DUCKDB_REQUIRE_FTS: "0" })).toBe(false);
        expect(requireFtsFromEnv({ AX_DUCKDB_REQUIRE_FTS: "false" })).toBe(false);
        expect(requireFtsFromEnv({ AX_DUCKDB_REQUIRE_FTS: "FALSE" })).toBe(false);
    });

    test("anything else means required", () => {
        expect(requireFtsFromEnv({ AX_DUCKDB_REQUIRE_FTS: "1" })).toBe(true);
        expect(requireFtsFromEnv({ AX_DUCKDB_REQUIRE_FTS: "true" })).toBe(true);
    });
});

describe("probeFtsCapable", () => {
    test("reports a reason instead of throwing when the library cannot be opened", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-fts-probe-"));
        try {
            const bogus = join(dir, libFileName());
            writeFileSync(bogus, "not a shared library");
            const capability = await probeFtsCapable(bogus);
            expect(capability.ok).toBe(false);
            if (!capability.ok) expect(capability.reason.length).toBeGreaterThan(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("agrees with the dylib the suites actually resolve", async () => {
        const found = await resolveTestDylib();
        if (!found.ok) return; // no dylib on this box; covered above
        const capability = await probeFtsCapable(found.path);
        // Not asserting WHICH answer - that depends on provisioning. Asserting
        // the probe returns a usable verdict rather than throwing, and that a
        // negative one always explains itself.
        if (!capability.ok) expect(capability.reason.length).toBeGreaterThan(0);
    });
});
