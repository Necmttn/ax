/**
 * `publishSnapshot` / `openSnapshot` - the atomic hand-off between the live,
 * ingest-locked database and the read-only snapshot every reader opens.
 *
 * Ruling R9: `Effect.either` does not exist in `effect@4.0.0-beta.78` - the
 * v4 equivalent is `Effect.result`, returning `Result.Result<A, E>` with
 * `_tag: "Success" | "Failure"` and the failure value on `.failure` (verified
 * against `node_modules/effect/src/Effect.ts:3454` and
 * `node_modules/effect/src/Result.ts:159`).
 *
 * Ruling R3 / task-7 brief note: `count(*)` decodes as `BIGINT`, which this
 * client keeps as `bigint` (see row-decode.ts) - so the expected values below
 * are `1n`/`2n`, not `1`/`2`.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";

const { dtest, tempDir, withDuckDb } = await duckdbTestSetup("duckdb snapshot");
const workDir = () => tempDir("ax-duckdb-snapshot-");

describe("publishSnapshot", () => {
    dtest(
        "copies the live database to the snapshot path and leaves no temp files",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* rw.exec("INSERT INTO t VALUES (1, 'first')");
                yield* rw.close;

                yield* db.publishSnapshot(live, snap);
                expect(existsSync(snap)).toBe(true);
                expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

                const reader = yield* db.openSnapshot(snap);
                expect(reader.readOnly).toBe(true);
                expect((yield* reader.query("SELECT note FROM t")).rows).toEqual([
                    { note: "first" },
                ]);
                yield* reader.close;
            }),
        ),
    );

    dtest(
        "a reader holding the OLD snapshot keeps reading while a new one is renamed into place",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* rw.exec("INSERT INTO t VALUES (1, 'v1')");
                yield* rw.close;
                yield* db.publishSnapshot(live, snap);

                // A reader opens v1 and HOLDS it open across the republish.
                const reader = yield* db.openSnapshot(snap);
                const inodeBefore = statSync(snap).ino;
                expect((yield* reader.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(1n);

                const rw2 = yield* db.open(live);
                yield* rw2.exec("INSERT INTO t VALUES (2, 'v2')");
                yield* rw2.close;
                yield* db.publishSnapshot(live, snap);

                // the path now points at a NEW inode ...
                expect(statSync(snap).ino).not.toBe(inodeBefore);
                // ... while the held reader still sees the OLD contents.
                expect((yield* reader.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(1n);
                yield* reader.close;

                // a fresh reader sees the new snapshot
                const fresh = yield* db.openSnapshot(snap);
                expect((yield* fresh.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(2n);
                yield* fresh.close;
            }),
        ),
    );

    dtest(
        "a failed publish leaves the previous snapshot intact",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER)");
                yield* rw.exec("INSERT INTO t VALUES (1)");
                yield* rw.close;
                yield* db.publishSnapshot(live, snap);

                const result = yield* Effect.result(
                    db.publishSnapshot(join(dir, "does-not-exist.duckdb"), snap),
                );
                expect(result._tag).toBe("Failure");

                const reader = yield* db.openSnapshot(snap);
                expect((yield* reader.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(1n);
                yield* reader.close;
                expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
            }),
        ),
    );

    // Fix round 1 evidence gap: the "missing livePath" case above returns at
    // the very first guard, before any temp file is ever created - so its
    // "no litter" assertion (and, less obviously, "previous snapshot
    // intact") holds vacuously and would pass against an implementation with
    // NO cleanup logic at all. This test forces the failure at the LAST
    // possible step instead - the final rename - by pre-seeding the
    // destination as a non-empty directory. Standard POSIX `rename(2)`
    // refuses to replace a non-empty directory with a file (no special
    // privilege needed, portable to Linux CI - unlike an immutable-file
    // trick, which is macOS-only), so CHECKPOINT/ATTACH/COPY/DETACH all run
    // to completion FIRST, producing a real, fully-populated temp snapshot
    // file on disk, and ONLY THEN does the rename fail. An implementation
    // with no cleanup logic would leave that real file sitting in `dir`,
    // which this test's `readdirSync` assertion would catch.
    dtest(
        "a failure at the final rename still removes the fully-copied temp file and leaves the destination untouched",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER)");
                yield* rw.exec("INSERT INTO t VALUES (1)");
                yield* rw.close;

                // Sabotage: `snap` is a non-empty directory, not a file -
                // the eventual `fs.rename(tmp, snap)` cannot succeed.
                mkdirSync(snap);
                mkdirSync(join(snap, "nested"));

                const result = yield* Effect.result(db.publishSnapshot(live, snap));
                expect(result._tag).toBe("Failure");

                // the destination is exactly as it was - still the pre-seeded
                // directory, never swapped for the temp file.
                expect(existsSync(join(snap, "nested"))).toBe(true);
                // and the fully-copied temp file (a real duckdb database, not
                // a stub) was removed - no litter, this time non-vacuously.
                expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
            }),
        ),
    );
});

// Cross-review P1-6 / P2-4: `publishSnapshot` trusted its arguments. With a
// `from` connection open on a DIFFERENT database it published that unrelated
// database under the caller's snapshot name; with live === snapshot it
// renamed the live pathname onto itself, leaving any later writer working on
// an unlinked inode. Both are now typed refusals, compared on the CANONICAL
// (realpath'd) form so `./x` and a symlinked alias cannot slip past.
describe("publishSnapshot argument checks", () => {
    dtest(
        "refuses to publish when options.from is open on a different database",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const other = join(dir, "other.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER)");
                yield* rw.close;

                const foreign = yield* db.open(other);
                yield* foreign.exec("CREATE TABLE other_table (id INTEGER)");

                const result = yield* Effect.result(db.publishSnapshot(live, snap, { from: foreign }));
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                    expect(result.failure._tag).toBe("SnapshotPublishError");
                    const message = (result.failure as { message: string }).message;
                    expect(message).toContain("other.duckdb");
                    expect(message).toContain("live.duckdb");
                }
                // nothing was published from the wrong database
                expect(existsSync(snap)).toBe(false);
                expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

                yield* foreign.close;
            }),
        ),
    );

    dtest(
        "accepts options.from opened through a path alias of the same database",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER)");
                yield* rw.exec("INSERT INTO t VALUES (1)");

                // Same file, spelled differently - canonicalization must see
                // through it rather than rejecting a legitimate publish.
                yield* db.publishSnapshot(join(dir, ".", "live.duckdb"), snap, { from: rw });
                const reader = yield* db.openSnapshot(snap);
                expect((yield* reader.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(1n);
                yield* reader.close;
                yield* rw.close;
            }),
        ),
    );

    dtest(
        "refuses to publish a database onto itself",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER)");
                yield* rw.close;

                for (const target of [live, join(dir, ".", "live.duckdb")]) {
                    const result = yield* Effect.result(db.publishSnapshot(live, target));
                    expect(result._tag).toBe("Failure");
                    if (result._tag === "Failure") {
                        expect(result.failure._tag).toBe("SnapshotPublishError");
                        expect((result.failure as { message: string }).message).toContain("same");
                    }
                }
                expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
            }),
        ),
    );
});

describe("publishSnapshot options.from (RULING R14)", () => {
    dtest(
        "publishing through the caller's own connection sees commits made through that same connection",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER)");
                yield* rw.exec("INSERT INTO t VALUES (1)");
                yield* rw.exec("INSERT INTO t VALUES (2)");
                yield* rw.exec("INSERT INTO t VALUES (3)");

                // Publish WHILE rw stays open, running the copy THROUGH rw.
                yield* db.publishSnapshot(live, snap, { from: rw });
                const reader1 = yield* db.openSnapshot(snap);
                expect((yield* reader1.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(3n);
                yield* reader1.close;

                // Commit MORE through the still-open writer and republish
                // through it again - the snapshot must reflect the new rows.
                yield* rw.exec("INSERT INTO t VALUES (4)");
                yield* rw.exec("INSERT INTO t VALUES (5)");
                yield* db.publishSnapshot(live, snap, { from: rw });
                const reader2 = yield* db.openSnapshot(snap);
                expect((yield* reader2.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(5n);
                yield* reader2.close;

                // `publishSnapshot` never closes a connection handed in via
                // `from` - it must still be usable here.
                expect((yield* rw.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(5n);
                yield* rw.close;
            }),
        ),
    );

    dtest(
        "documented hazard: WITHOUT `from`, publishing while the same-process writer stays open can freeze the snapshot at a stale row count",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER)");
                yield* rw.exec("INSERT INTO t VALUES (1)");
                yield* rw.exec("INSERT INTO t VALUES (2)");
                yield* rw.exec("INSERT INTO t VALUES (3)");

                // No `from` - publishSnapshot opens its OWN handle on `live`
                // while `rw` is still open in this same process (RULING R14).
                yield* db.publishSnapshot(live, snap);
                const reader1 = yield* db.openSnapshot(snap);
                expect((yield* reader1.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(3n);
                yield* reader1.close;

                // The writer commits two MORE rows while still open ...
                yield* rw.exec("INSERT INTO t VALUES (4)");
                yield* rw.exec("INSERT INTO t VALUES (5)");
                expect((yield* rw.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(5n);

                // ... but a second no-`from` publish, still with the writer
                // open, does NOT see them: this is the documented hazard -
                // a stale snapshot, silently, with no error raised.
                yield* db.publishSnapshot(live, snap);
                const reader2 = yield* db.openSnapshot(snap);
                expect((yield* reader2.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(3n);
                yield* reader2.close;

                yield* rw.close;

                // Once the writer is closed, a fresh no-`from` publish sees
                // everything - confirming the 5 rows really were committed to
                // disk all along, and the earlier staleness was purely a
                // same-process, writer-still-open artifact of opening a
                // second handle on `live`, not data loss.
                yield* db.publishSnapshot(live, snap);
                const reader3 = yield* db.openSnapshot(snap);
                expect((yield* reader3.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(5n);
                yield* reader3.close;
            }),
        ),
    );

    // Fix round 2: before this round, the ATTACH...DETACH span ran as a flat
    // sequence with no `Effect.ensuring`. That was harmless for the no-`from`
    // path (its connection is always closed unconditionally right after, and
    // closing a DuckDB handle tears down its attachments anyway) - but the
    // WHOLE POINT of `from` is a long-lived, caller-owned connection reused
    // across repeated publishes. A mid-copy failure left `ax_snapshot`
    // permanently attached on that connection, so every LATER publish
    // through it failed forever with "database ax_snapshot already exists" -
    // silently, since the connection stayed otherwise perfectly usable.
    dtest(
        "a mid-copy failure on the `from` path still leaves the connection usable for a later publish",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                // #908: this case specifically exercises the LOGICAL copy
                // path's ATTACH/DETACH robustness under a mid-`COPY FROM
                // DATABASE` OOM failure - a filesystem clonefile never touches
                // DuckDB's `memory_limit`, so the clone fast path would just
                // succeed here and the whole scenario below would be moot.
                // Forcing the logical path is what keeps this test exercising
                // what its name says it exercises.
                const previousClone = process.env.AX_SNAPSHOT_CLONE;
                process.env.AX_SNAPSHOT_CLONE = "off";
                try {
                    const rw = yield* db.open(live);
                    yield* rw.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                    for (let i = 0; i < 3000; i++) {
                        yield* rw.exec(`INSERT INTO t VALUES (${i}, '${"x".repeat(2000)}')`);
                    }
                    // Flush normally at full memory, THEN clamp memory_limit so
                    // the COPY step itself (not CHECKPOINT, which has nothing
                    // left to flush) runs out of memory - a real, non-fatal
                    // DuckDB error ("Out of Memory Error: failed to pin block"),
                    // not the FATAL "database has been invalidated" error a low
                    // memory_limit produces during an actual checkpoint. This
                    // leaves `rw` perfectly usable afterward, matching the
                    // documented hazard exactly: the connection looks fine, only
                    // `publishSnapshot` through it is broken.
                    yield* rw.exec("CHECKPOINT");
                    yield* rw.exec("PRAGMA memory_limit='2MB'");

                    // THE ASSERTION THAT MATTERS: `publishSnapshot` ATTACHes a
                    // randomly-aliased database on `rw` and must DETACH it again
                    // on every path, including a mid-copy failure - a leaked
                    // attachment does NOT collide with any later publish (the
                    // alias is a fresh `crypto.randomUUID()` per call, so "a
                    // later publish through the same connection still succeeds"
                    // proves nothing: it passes even with
                    // `Effect.ensuring(detach)` deleted entirely). The direct
                    // check is the attachment count on `rw` itself, via
                    // `duckdb_databases()`, taken immediately before and after
                    // the failed publish.
                    const attachmentCount = () =>
                        Effect.gen(function* () {
                            const result = yield* rw.query("SELECT count(*) AS n FROM duckdb_databases()");
                            return result.rows[0]!.n as bigint;
                        });

                    const attachmentsBefore = yield* attachmentCount();

                    const first = yield* Effect.result(db.publishSnapshot(live, snap, { from: rw }));
                    expect(first._tag).toBe("Failure");

                    const attachmentsAfter = yield* attachmentCount();
                    expect(attachmentsAfter).toBe(attachmentsBefore);

                    // restore normal memory and confirm the connection is
                    // otherwise completely healthy - the failure was ordinary,
                    // not fatal.
                    yield* rw.exec("PRAGMA memory_limit='4GB'");
                    expect((yield* rw.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(3000n);

                    // A subsequent publish through the same connection still
                    // succeeds too, kept as a secondary end-to-end check.
                    const second = yield* Effect.result(db.publishSnapshot(live, snap, { from: rw }));
                    expect(second._tag).toBe("Success");

                    yield* rw.close;
                } finally {
                    if (previousClone === undefined) delete process.env.AX_SNAPSHOT_CLONE;
                    else process.env.AX_SNAPSHOT_CLONE = previousClone;
                }
            }),
        ),
        // bun's default 5000ms is a LOCAL number. This case does real DuckDB
        // work three times over - a 3000-row build, a publish forced to fail
        // under a memory cap, then a second full publish - and on a loaded CI
        // runner (that whole suite run took 372s against 96s locally) it timed
        // out at 5070ms. The timeout was measuring the runner, not the code:
        // the same case passes locally every time. 30s is generous enough that
        // a failure here means the connection really did stay wedged.
        30_000,
    );
});

// #908: the clone fast path. `workDir()` places `live.duckdb` and the
// staged temp file in the SAME directory (a plain `os.tmpdir()` subdirectory
// under the repo's root APFS volume in this dev/CI environment), which is
// exactly what `cloneFile` needs - clonefile only works within one
// filesystem. These cases run with the default (clone-enabled) settings, so
// on this machine they exercise the clone path; the WAL-tripwire and
// torn-copy-tripwire GUARD FUNCTIONS themselves (hard to force through a real
// checkpoint race) are unit-tested directly in `clone-file.test.ts`
// (`walIsQuiescent`, `statsEqual`) rather than synthesized here. Per the
// brief, `publishSnapshot`'s public signature stays `Effect<void, ...>` (no
// added discriminator), so these assert OBSERVABLE BEHAVIOR - data parity and
// the reader-holds-old-inode property - not which internal path ran.
describe("publishSnapshot clone-based fast path (#908)", () => {
    dtest(
        "publishes identical data through the clone fast path (options.from)",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* rw.exec("INSERT INTO t VALUES (1, 'first')");
                yield* rw.exec("INSERT INTO t VALUES (2, 'second')");

                yield* db.publishSnapshot(live, snap, { from: rw });

                expect(existsSync(snap)).toBe(true);
                expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

                const reader = yield* db.openSnapshot(snap);
                expect(reader.readOnly).toBe(true);
                expect((yield* reader.query("SELECT id, note FROM t ORDER BY id")).rows).toEqual([
                    { id: 1, note: "first" },
                    { id: 2, note: "second" },
                ]);
                yield* reader.close;
                yield* rw.close;
            }),
        ),
    );

    dtest(
        "publishes identical data through the clone fast path (no options.from)",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* rw.exec("INSERT INTO t VALUES (1, 'only')");
                yield* rw.close;

                yield* db.publishSnapshot(live, snap);

                const reader = yield* db.openSnapshot(snap);
                expect((yield* reader.query("SELECT note FROM t")).rows).toEqual([{ note: "only" }]);
                yield* reader.close;
            }),
        ),
    );

    // Pins the SAME reader-isolation property `snapshot.test.ts` already
    // covers for the logical path, under the clone path this time: a reader
    // that opened the OLD snapshot before a republish must keep seeing the
    // OLD data uninterrupted, because the clone lands at a temp sibling and
    // only the atomic rename swaps it in - identical guarantee, different
    // mechanism for producing the temp file.
    dtest(
        "a reader holding the OLD snapshot keeps reading while a new one is cloned into place",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* rw.exec("INSERT INTO t VALUES (1, 'v1')");
                yield* db.publishSnapshot(live, snap, { from: rw });

                const reader = yield* db.openSnapshot(snap);
                const inodeBefore = statSync(snap).ino;
                expect((yield* reader.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(1n);

                yield* rw.exec("INSERT INTO t VALUES (2, 'v2')");
                yield* db.publishSnapshot(live, snap, { from: rw });

                // a NEW inode is now published ...
                expect(statSync(snap).ino).not.toBe(inodeBefore);
                // ... while the reader holding the OLD handle is unaffected.
                expect((yield* reader.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(1n);
                yield* reader.close;

                const fresh = yield* db.openSnapshot(snap);
                expect((yield* fresh.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(2n);
                yield* fresh.close;
                yield* rw.close;
            }),
        ),
    );

    // AX_SNAPSHOT_CLONE=off is the escape hatch: it must force the logical
    // path unconditionally, and a publish under it must still succeed with
    // full data parity - the minimal observable assertion the brief calls
    // for, since forcing a CLONE failure to prove "off" skipped a working
    // clone isn't reliably constructible here.
    dtest(
        "AX_SNAPSHOT_CLONE=off forces the logical path and still publishes correctly",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* rw.exec("INSERT INTO t VALUES (1, 'off-path')");
                yield* rw.exec("INSERT INTO t VALUES (2, 'still-works')");

                const previous = process.env.AX_SNAPSHOT_CLONE;
                process.env.AX_SNAPSHOT_CLONE = "off";
                try {
                    yield* db.publishSnapshot(live, snap, { from: rw });
                } finally {
                    if (previous === undefined) delete process.env.AX_SNAPSHOT_CLONE;
                    else process.env.AX_SNAPSHOT_CLONE = previous;
                }

                expect(existsSync(snap)).toBe(true);
                expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

                const reader = yield* db.openSnapshot(snap);
                expect((yield* reader.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(2n);
                yield* reader.close;
                yield* rw.close;
            }),
        ),
    );
});
