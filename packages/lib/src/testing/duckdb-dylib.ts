/**
 * Test-only resolution of a libduckdb shared library.
 *
 * Order: `AX_DUCKDB_DYLIB` (the injection point tests use to point at an
 * arbitrary dylib) -> the custom static build at
 * `${DUCKDB_DIST_DIR ?? <repoRoot>/dist/duckdb}/<libFileName()>` (produced by
 * `scripts/build-duckdb.sh`; the ONLY artifact that can `LOAD fts` offline) ->
 * the gitignored `vendor/duckdb/<version>/` cache -> a one-time download of
 * the official prebuilt release. When the download is impossible (offline
 * CI, unsupported platform) this returns a REASON rather than throwing, so
 * suites can skip with a notice instead of failing red for an environment
 * problem.
 *
 * The download is SINGLE-FLIGHT across processes (cross-review P3-4): one
 * caller claims an exclusive-create sentinel and downloads, everyone else
 * waits for the published library rather than racing it into the same files.
 *
 * `node:fs` is used deliberately here and only here in this module family:
 * this is a TEST FIXTURE, not runtime code, so the `check:no-node-fs` gate
 * (which scans runtime sources) does not apply and an Effect `FileSystem`
 * would only add ceremony to something that runs before any layer exists.
 */
import { afterAll, test } from "bun:test";
import { Effect, type Layer } from "effect";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DuckDb, DuckDbLayer, type DuckDbService } from "../duckdb/client.ts";
import type { DuckDbDylibError } from "../duckdb/errors.ts";

export const DUCKDB_VERSION = "v1.5.5";

export type TestDylib =
    | { readonly ok: true; readonly path: string }
    | { readonly ok: false; readonly reason: string };

export type RepoRootResult = { readonly ok: true; readonly dir: string } | { readonly ok: false };

/**
 * Walk up from `startDir` looking for the directory holding `turbo.json`.
 * Exported separately from `repoRoot()` below so the failure path (no
 * `turbo.json` found within 10 levels) is unit-testable without having to
 * fake `import.meta.url`.
 */
export const repoRootFrom = (startDir: string): RepoRootResult => {
    let dir = startDir;
    for (let i = 0; i < 10; i += 1) {
        if (existsSync(join(dir, "turbo.json"))) return { ok: true, dir };
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return { ok: false };
};

/**
 * Repo root, found by walking up from this file. Uses `Bun.fileURLToPath`
 * (not `new URL(...).pathname`) because the pathname is percent-encoded -
 * a checkout under a path with a space or non-ASCII character (e.g.
 * `/Users/x/My Projects/...`) would make every `existsSync` probe below miss
 * and the walk would exhaust silently.
 */
const repoRoot = (): RepoRootResult => repoRootFrom(dirname(Bun.fileURLToPath(import.meta.url)));

/** Exported so callers (e.g. the custom-build priority test) can build a
 *  platform-correct path without duplicating the darwin/linux switch. */
export const libFileName = (): string => (platform() === "darwin" ? "libduckdb.dylib" : "libduckdb.so");

/** The custom static-build dist dir: `DUCKDB_DIST_DIR`, or `<repoRoot>/dist/duckdb`
 *  when unset. Mirrors what `scripts/build-duckdb.sh` writes to and what
 *  `scripts/bench/duckdb-bin.ts` resolves the CLI binary against. */
export const customBuildDistDir = (root: string): string =>
    process.env.DUCKDB_DIST_DIR?.trim() || join(root, "dist", "duckdb");

/** Official release asset for this platform, or null when unsupported. */
const releaseAsset = (): string | null => {
    if (platform() === "darwin") return "libduckdb-osx-universal.zip";
    if (platform() === "linux") {
        return arch() === "arm64" ? "libduckdb-linux-arm64.zip" : "libduckdb-linux-amd64.zip";
    }
    return null;
};

export const vendorDir = (root: string): string => join(root, "vendor", "duckdb", DUCKDB_VERSION);

/**
 * How long a download sentinel may sit before it is treated as a corpse from
 * a crashed or killed test process. Generous next to a ~40MB download, short
 * enough that a killed CI job does not wedge the next one.
 */
const SENTINEL_STALE_MS = 10 * 60_000;

/** How long a waiting process gives the downloader before giving up. */
const SENTINEL_WAIT_MS = 5 * 60_000;
const SENTINEL_POLL_MS = 100;

/**
 * Claim the exclusive right to run the download (cross-review P3-4).
 *
 * `bun test` can run several files - and CI several jobs - against ONE vendor
 * directory, and the download wrote a fixed zip path and unzipped into a
 * fixed directory. A second process arriving mid-download could read a
 * partial archive, or a partially-extracted `libduckdb.dylib`, and fail with
 * something that looks like a real dylib bug. Exactly one caller downloads;
 * everyone else waits for the result (see `waitForFile`).
 *
 * `openSync(..., "wx")` is the atomic primitive - the same one the ingest
 * lock uses - and a sentinel older than `SENTINEL_STALE_MS` is reclaimed so a
 * crashed process cannot wedge every later run.
 */
export const claimDownloadSentinel = (sentinelPath: string): "claimed" | "busy" => {
    try {
        closeSync(openSync(sentinelPath, "wx"));
        return "claimed";
    } catch {
        try {
            const age = Date.now() - statSync(sentinelPath).mtimeMs;
            if (age < SENTINEL_STALE_MS) return "busy";
            rmSync(sentinelPath, { force: true });
            closeSync(openSync(sentinelPath, "wx"));
            return "claimed";
        } catch {
            // Either it vanished under us or another process reclaimed it
            // first - both mean "somebody else is on it".
            return "busy";
        }
    }
};

export const releaseDownloadSentinel = (sentinelPath: string): void => {
    rmSync(sentinelPath, { force: true });
};

/** Wait for the download holder to publish `target`. */
const waitForFile = async (target: string, sentinelPath: string): Promise<boolean> => {
    const deadline = Date.now() + SENTINEL_WAIT_MS;
    while (Date.now() < deadline) {
        if (existsSync(target)) return true;
        // The holder died without publishing: stop waiting on a ghost.
        if (!existsSync(sentinelPath)) return existsSync(target);
        await Bun.sleep(SENTINEL_POLL_MS);
    }
    return existsSync(target);
};

export const resolveTestDylib = async (): Promise<TestDylib> => {
    const injected = process.env.AX_DUCKDB_DYLIB?.trim();
    if (injected) {
        return existsSync(injected)
            ? { ok: true, path: injected }
            : { ok: false, reason: `AX_DUCKDB_DYLIB points at a missing file: ${injected}` };
    }

    const root = repoRoot();
    if (!root.ok) {
        return {
            ok: false,
            reason:
                "could not locate the repo root (walked up 10 levels from duckdb-dylib.ts without finding turbo.json)",
        };
    }
    const customBuild = join(customBuildDistDir(root.dir), libFileName());
    if (existsSync(customBuild)) return { ok: true, path: customBuild };

    const dir = vendorDir(root.dir);

    const cached = join(dir, libFileName());
    if (existsSync(cached)) return { ok: true, path: cached };

    const asset = releaseAsset();
    if (asset === null) {
        return { ok: false, reason: `no official libduckdb build for ${platform()}/${arch()}` };
    }

    const url = `https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/${asset}`;
    mkdirSync(dir, { recursive: true });

    // Cross-review P3-4: single-flight. Parallel test processes shared one
    // zip path and one extraction directory, so a late arrival could read a
    // half-written archive or a half-extracted library.
    const sentinelPath = join(dir, `${asset}.download.lock`);
    if (claimDownloadSentinel(sentinelPath) === "busy") {
        const published = await waitForFile(cached, sentinelPath);
        return published
            ? { ok: true, path: cached }
            : {
                  ok: false,
                  reason: `another process is downloading ${asset} and did not publish ${cached} in time; re-run, or remove ${sentinelPath} if nothing is downloading`,
              };
    }

    try {
        // Own the staged archive too: the sentinel already serializes
        // downloaders, but a pid-scoped name keeps a leftover zip from a
        // killed run out of this one's way.
        const zipPath = join(dir, `${asset}.${process.pid}.part`);
        try {
            const response = await fetch(url);
            if (!response.ok) {
                return { ok: false, reason: `download failed: ${url} -> HTTP ${response.status}` };
            }
            await Bun.write(zipPath, await response.arrayBuffer());
            const unzip = Bun.spawnSync(["unzip", "-o", "-q", zipPath, "-d", dir], {
                stdout: "ignore",
                stderr: "pipe",
            });
            if (unzip.exitCode !== 0) {
                return { ok: false, reason: `unzip failed: ${unzip.stderr.toString().trim()}` };
            }
            if (!existsSync(cached)) {
                return { ok: false, reason: `archive ${asset} did not contain ${libFileName()}` };
            }
            return { ok: true, path: cached };
        } finally {
            rmSync(zipPath, { force: true });
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `download failed: ${url} -> ${message}` };
    } finally {
        releaseDownloadSentinel(sentinelPath);
    }
};

/** Prints a uniform notice so a skipped suite is visible in test output. */
export const noteSkippedDylib = (suite: string, reason: string): void => {
    console.warn(`[skip] ${suite}: no libduckdb available (${reason})`);
};

// ---------------------------------------------------------------------------
// FTS capability - "is there a libduckdb?" is NOT the whole question
// ---------------------------------------------------------------------------

/**
 * `resolveTestDylib` answers "is there a libduckdb?". Suites treated that as
 * sufficient, and it is not: ax links the `fts` extension STATICALLY into its
 * own build (`scripts/build-duckdb.sh`), and the upstream release artifact
 * this module downloads as a last resort does not carry fts at all. Every
 * suite that publishes a cache fixture goes through `buildFtsIndexes`, so it
 * needs `LOAD fts` to work - and against the upstream artifact it does not.
 *
 * The failure this was written for: CI provisioned no DuckDB, fell through to
 * the upstream download, and 36 behaviour tests died with
 * `Install it first using "INSTALL fts"` - one provisioning gap wearing the
 * costume of 36 unrelated product bugs. The same suites were GREEN locally,
 * because a developer box that has ever run `INSTALL fts` keeps the extension
 * in `~/.duckdb/extensions/<version>/<platform>/` where ANY dylib picks it up.
 * Green locally, red in CI, and neither answer was about the code under test.
 *
 * So capability is PROBED, and the answer carries a reason a human can act on.
 */
export type FtsCapability = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The one place the "how do I get a working DuckDB" answer is written down. */
export const ftsProvisioningHint = (reason: string): string =>
    [
        `no FTS-capable libduckdb: ${reason}`,
        `ax links the fts extension STATICALLY into its own DuckDB ${DUCKDB_VERSION} build.`,
        `The upstream release artifact CANNOT "LOAD fts" - it ships fts as a separate download.`,
        `Build the real one:  bash scripts/build-duckdb.sh   (lands in dist/duckdb/, picked up automatically)`,
        `Or point at an existing one:  DUCKDB_DIST_DIR=/path/to/dist/duckdb`,
    ].join("\n");

/**
 * Probe by issuing `LOAD fts` EXACTLY as {@link buildFtsIndexes} does - no
 * air-gap pragmas. Probing differently from the code under test is how you get
 * a probe that disagrees with reality: an air-gapped probe would report
 * "incapable" on a developer box whose suites do in fact pass. Whether the
 * SHIPPED artifact links fts statically is a different question, and
 * `scripts/build-duckdb.sh`'s air-gap smoke is what answers it.
 */
export const probeFtsCapable = async (dylibPath: string): Promise<FtsCapability> => {
    const program = Effect.gen(function* () {
        const db = yield* DuckDb;
        const conn = yield* db.open(":memory:");
        yield* Effect.ensuring(conn.exec("LOAD fts"), conn.close);
    });
    try {
        await Effect.runPromise(
            Effect.provide(program, DuckDbLayer(dylibPath)) as Effect.Effect<void>,
        );
        return { ok: true };
    } catch (err) {
        // DuckDB's answer is several lines ("IO Error: Extension ... not
        // found." / "Install it first using \"INSTALL fts\"."); the first
        // non-empty one identifies it without burying the hint that follows.
        const text = err instanceof Error ? err.message : String(err);
        const first = text.split("\n").find((line) => line.trim().length > 0)?.trim();
        return { ok: false, reason: first && first.length > 0 ? first : "LOAD fts failed" };
    }
};

/**
 * CI sets `AX_DUCKDB_REQUIRE_FTS=1`. It turns "no FTS-capable duckdb" from a
 * skip into a hard failure, so a broken provisioning step can never be
 * mistaken for a green run. Locally it stays unset and suites skip with the
 * hint instead of demanding an hour-long DuckDB build from every contributor.
 */
export const requireFtsFromEnv = (
    env: Record<string, string | undefined> = process.env,
): boolean => {
    const raw = env.AX_DUCKDB_REQUIRE_FTS?.trim().toLowerCase();
    if (raw === undefined || raw === "") return false;
    return raw !== "0" && raw !== "false";
};

export type FtsGate =
    | { readonly mode: "run" }
    | { readonly mode: "skip"; readonly message: string }
    | { readonly mode: "fail"; readonly message: string };

/** Pure decision, so the policy is testable without a dylib on disk. */
export const decideFtsGate = (capability: FtsCapability, required: boolean): FtsGate => {
    if (capability.ok) return { mode: "run" };
    const message = ftsProvisioningHint(capability.reason);
    return required ? { mode: "fail", message } : { mode: "skip", message };
};

/** F1: the pasted preamble every `duckdb/*.test.ts` suite carried - resolve a
 *  dylib, build a skip-aware `test`, and (for suites that open a real
 *  database) a `DuckDb` layer + temp-dir tracker + a `withDuckDb` runner.
 *  Previously hand-copied into client.test.ts, snapshot.test.ts, and
 *  ffi.test.ts. */
export interface DuckDbTestSetupOptions {
    /**
     * The suite reaches `buildFtsIndexes` - directly, or through
     * `publishCacheFixture`, which builds the indexes for EVERY fixture. Such
     * a suite needs a dylib that can `LOAD fts`, not merely a dylib.
     */
    readonly requireFts?: boolean;
}

export interface DuckDbTestSetup {
    /** The resolved dylib path, or `null` when none is available. */
    readonly dylibPath: string | null;
    /** `test`, bound to skip (not pass) every dylib-dependent case when no
     *  dylib is available - registering at module load (not inside a
     *  `beforeAll`) so bun reports a real SKIP status instead of a silent
     *  PASS on a dylib-less box. */
    readonly dtest: typeof test;
    /** `DuckDbLayer(dylibPath)`, or `null` when no dylib is available. Only
     *  ever consumed through `withDuckDb` below - exposed too for a suite
     *  that needs to `Effect.provide` it directly. */
    readonly layer: Layer.Layer<DuckDb, DuckDbDylibError> | null;
    /**
     * A fresh `mkdtemp`-created directory under `<prefix>`, tracked for
     * cleanup in one `afterAll` this call registers the first time it runs
     * (so every suite gets exactly one, however many `tempDir` calls it
     * makes) - mirrors the measured leak fix in dylib.test.ts.
     */
    readonly tempDir: (prefix: string) => string;
    /** Runs `body` with the `DuckDb` service, through `layer`. Only safe to
     *  call from a case registered via `dtest` (which skips registration
     *  entirely when `layer` is null) - the non-null assertion is safe by
     *  construction. */
    readonly withDuckDb: <A>(
        body: (db: DuckDbService) => Effect.Effect<A, unknown>,
    ) => () => Promise<void>;
}

/**
 * Build a {@link DuckDbTestSetup} for one suite. `suiteName` labels the
 * skip notice (e.g. `"duckdb client"`) exactly as the hand-copied preambles
 * did. Call once per test file, at module load (`await duckdbTestSetup(...)`
 * at the top level) so `dtest` sees a real boolean at registration time.
 */
export const duckdbTestSetup = async (
    suiteName: string,
    options: DuckDbTestSetupOptions = {},
): Promise<DuckDbTestSetup> => {
    const found = await resolveTestDylib();
    let dylibPath = found.ok ? found.path : null;
    if (!found.ok && options.requireFts !== true) noteSkippedDylib(suiteName, found.reason);

    // An FTS suite asks a stricter question than "is there a dylib?", so it
    // gets a stricter answer - and when provisioning is broken it gets ONE
    // actionable failure instead of every case in the file dying on the same
    // extension error.
    if (options.requireFts === true) {
        const capability: FtsCapability =
            dylibPath === null
                ? { ok: false, reason: found.ok ? "no libduckdb resolved" : found.reason }
                : await probeFtsCapable(dylibPath);
        const gate = decideFtsGate(capability, requireFtsFromEnv());
        if (gate.mode !== "run") {
            dylibPath = null;
            if (gate.mode === "fail") {
                test(`${suiteName}: an FTS-capable libduckdb is required`, () => {
                    throw new Error(gate.message);
                });
            } else {
                console.warn(`[skip] ${suiteName}: ${gate.message}`);
            }
        }
    }

    const layer = dylibPath !== null ? DuckDbLayer(dylibPath) : null;
    const dtest = test.skipIf(dylibPath === null);

    // Publish the resolved path into the environment.
    //
    // A suite gets the dylib as a PATH, and hands it to the read side
    // explicitly (`CacheReadLayer({ assetPath })`). The WRITE side has no such
    // argument: `withCacheWrite` / `withConfigWrite` open their own connection,
    // and `resolveDylib` can only find the library through
    // `AX_DUCKDB_DYLIB` or a default on-disk location. So any suite that reads
    // through the layer and writes through a service resolved the library on
    // one half and not the other.
    //
    // That never reproduced locally: a developer box has the library at the
    // default cache path, so the write half resolved it anyway. On CI the
    // library exists ONLY as a build artifact handed back as a path, and the
    // write half failed with `no libduckdb available`. Three suites hit it
    // separately (classifier package + label-mining services, workflow
    // candidates) before it was fixed here instead of case by case.
    //
    // Setting it to the value `resolveTestDylib` just returned is idempotent -
    // that function reads this same variable FIRST, so the next resolution is
    // unchanged. It is deliberately NOT set when `dylibPath` is null: the FTS
    // gate nulls the path to mean "unavailable", and exporting a library the
    // gate rejected would defeat it. Suites that need the variable ABSENT
    // (dylib fallback-order tests) delete it around their own case.
    const previousDylibEnv = process.env.AX_DUCKDB_DYLIB;
    if (dylibPath !== null) process.env.AX_DUCKDB_DYLIB = dylibPath;

    const createdTempDirs: string[] = [];
    afterAll(() => {
        for (const dir of createdTempDirs) rmSync(dir, { recursive: true, force: true });
        if (previousDylibEnv === undefined) delete process.env.AX_DUCKDB_DYLIB;
        else process.env.AX_DUCKDB_DYLIB = previousDylibEnv;
    });
    const tempDir = (prefix: string): string => {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        createdTempDirs.push(dir);
        return dir;
    };

    const withDuckDb = <A>(body: (db: DuckDbService) => Effect.Effect<A, unknown>) => async () => {
        await Effect.runPromise(
            Effect.gen(function* () {
                const db = yield* DuckDb;
                yield* body(db);
            }).pipe(Effect.provide(layer as NonNullable<typeof layer>)) as Effect.Effect<void>,
        );
    };

    return { dylibPath, dtest, layer, tempDir, withDuckDb };
};
