/**
 * `snapshotPath()` must be rooted by the SAME thing that roots the live DB.
 *
 * This is a regression guard, not a unit-test formality. The live DB is
 * `<dataDir>/ax-live.duckdb` (`ingest/run.ts`, `cli/commands/ingest.ts`,
 * `config-core/reconcile.ts` all spell it that way), and `dylibCacheDir()`
 * honours `AX_DATA_DIR` too - but `snapshotPath()` did not. So pointing
 * `AX_DATA_DIR` at an empty directory and running `ax ingest --since=1` built a
 * live DB inside the isolated dir and then PUBLISHED it over the real
 * `~/.ax/cache/ax-snapshot.duckdb`. Exit 0, no warning; afterwards every read
 * surface answered "no data" rather than failing. Measured on a real machine: a
 * 636 MB isolated store replaced the real snapshot and `ax recall` went from
 * 1014 hits to zero.
 *
 * Both sides of the seam resolve through this one function - reads at
 * `seam.ts` `defaultSnapshotPath()` in the CacheRead constructor, and the
 * publish target in `withCacheWrite` - so keeping them rooted together is the
 * whole property. If someone "simplifies" this back to a bare homedir default,
 * these tests are what says no.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join as posixJoin } from "node:path/posix";
import { snapshotPath } from "./client.ts";
import { dylibCacheDir } from "./dylib.ts";

const ENV_KEYS = ["AX_DUCKDB_SNAPSHOT", "AX_DATA_DIR"] as const;
const saved = new Map<string, string | undefined>();

const setEnv = (key: (typeof ENV_KEYS)[number], value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
};

afterEach(() => {
    for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    saved.clear();
});

describe("snapshotPath", () => {
    test("falls back to ~/.ax/cache/ax-snapshot.duckdb when neither var is set", () => {
        setEnv("AX_DUCKDB_SNAPSHOT", undefined);
        setEnv("AX_DATA_DIR", undefined);
        expect(snapshotPath()).toBe(posixJoin(homedir(), ".ax", "cache", "ax-snapshot.duckdb"));
    });

    test("AX_DATA_DIR roots the snapshot beside the live DB it isolates", () => {
        setEnv("AX_DUCKDB_SNAPSHOT", undefined);
        setEnv("AX_DATA_DIR", "/tmp/ax-isolated");
        // The live DB is `<dataDir>/ax-live.duckdb`; the snapshot must be a
        // sibling, or a publish escapes the isolation and lands on the real one.
        expect(snapshotPath()).toBe("/tmp/ax-isolated/ax-snapshot.duckdb");
    });

    test("an isolated data dir NEVER resolves to the real home snapshot", () => {
        setEnv("AX_DUCKDB_SNAPSHOT", undefined);
        setEnv("AX_DATA_DIR", "/tmp/ax-isolated");
        const real = posixJoin(homedir(), ".ax", "cache", "ax-snapshot.duckdb");
        // This is the exact assertion the defect violated.
        expect(snapshotPath()).not.toBe(real);
    });

    test("AX_DUCKDB_SNAPSHOT wins over AX_DATA_DIR", () => {
        setEnv("AX_DATA_DIR", "/tmp/ax-isolated");
        setEnv("AX_DUCKDB_SNAPSHOT", "/tmp/pinned/snap.duckdb");
        expect(snapshotPath()).toBe("/tmp/pinned/snap.duckdb");
    });

    test("a whitespace-only override is ignored, not used as a path", () => {
        setEnv("AX_DATA_DIR", undefined);
        setEnv("AX_DUCKDB_SNAPSHOT", "   ");
        expect(snapshotPath()).toBe(posixJoin(homedir(), ".ax", "cache", "ax-snapshot.duckdb"));
    });

    test("a whitespace-only AX_DATA_DIR is ignored, not joined", () => {
        setEnv("AX_DUCKDB_SNAPSHOT", undefined);
        setEnv("AX_DATA_DIR", "   ");
        expect(snapshotPath()).toBe(posixJoin(homedir(), ".ax", "cache", "ax-snapshot.duckdb"));
    });

    test("snapshot and dylib cache agree on which root AX_DATA_DIR selects", () => {
        setEnv("AX_DUCKDB_SNAPSHOT", undefined);
        setEnv("AX_DATA_DIR", "/tmp/ax-isolated");
        // Both are data-dir-rooted paths under the same base. The point is not
        // the exact leaf names - it is that neither one silently reaches back
        // into $HOME while the other honours the isolation.
        expect(dylibCacheDir().startsWith("/tmp/ax-isolated")).toBe(true);
        expect(snapshotPath().startsWith("/tmp/ax-isolated")).toBe(true);
    });
});
