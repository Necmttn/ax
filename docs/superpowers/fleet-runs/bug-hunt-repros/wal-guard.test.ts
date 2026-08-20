import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { BunFileSystem } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/node_modules/.bun/@effect+platform-bun@4.0.0-beta.78+1ccbc7ebc433c9b1/node_modules/@effect/platform-bun/dist/index.js";
import { FileSystem } from "effect";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walIsQuiescent, statSnapshot } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/duckdb/clone-file.ts";

describe("walIsQuiescent fail-open", () => {
    test("an UNREADABLE non-empty WAL is reported quiescent", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-wal-"));
        const sub = join(dir, "locked");
        mkdirSync(sub);
        const live = join(sub, "live.duckdb");
        writeFileSync(live, "db");
        writeFileSync(`${live}.wal`, "PENDING COMMITTED DATA");   // non-empty WAL
        // make the containing dir unsearchable -> stat() fails with EACCES
        chmodSync(sub, 0o000);
        const prog = Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const q = yield* walIsQuiescent(fs, live);
            const s = yield* Effect.result(statSnapshot(fs, live));
            return { q, statTag: s._tag };
        }).pipe(Effect.provide(BunFileSystem.layer));
        const out = await Effect.runPromise(prog);
        chmodSync(sub, 0o700);
        console.log("walIsQuiescent on an unreadable NON-EMPTY wal =>", out.q, "| statSnapshot(live) =>", out.statTag);
        expect(out.q).toBe(true);   // <- fails OPEN: guard (b) passes
    });

    test("mtime grain from Effect fs.stat", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-mt-"));
        const f = join(dir, "f");
        writeFileSync(f, "a");
        const prog = Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* statSnapshot(fs, f);
        }).pipe(Effect.provide(BunFileSystem.layer));
        const s = await Effect.runPromise(prog);
        const bunMs = (await Bun.file(f).stat()).mtimeMs;
        console.log("statSnapshot.mtimeMs =", s.mtimeMs, "| Bun stat mtimeMs =", bunMs, "| integer-ms?", Number.isInteger(s.mtimeMs));
    });
});
