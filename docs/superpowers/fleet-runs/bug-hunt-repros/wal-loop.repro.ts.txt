import { describe, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { BunFileSystem } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/node_modules/.bun/@effect+platform-bun@4.0.0-beta.78+1ccbc7ebc433c9b1/node_modules/@effect/platform-bun/dist/index.js";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walIsQuiescent, statSnapshot } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/duckdb/clone-file.ts";

describe("walIsQuiescent: WAL-only stat failure, live file fine", () => {
    test("symlink loop at <live>.wal => quiescent=true while the live file stats fine", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-walloop-"));
        const live = join(dir, "live.duckdb");
        writeFileSync(live, "db-bytes");
        // ELOOP: <live>.wal -> <live>.wal
        symlinkSync(`${live}.wal`, `${live}.wal`);
        const prog = Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const q = yield* walIsQuiescent(fs, live);
            const s = yield* Effect.result(statSnapshot(fs, live));
            return { q, statTag: s._tag };
        }).pipe(Effect.provide(BunFileSystem.layer));
        const out = await Effect.runPromise(prog);
        console.log("guard(b) walIsQuiescent =>", out.q, "| guard(c) pre-clone statSnapshot(live) =>", out.statTag);
        expect(out.q).toBe(true);
        expect(out.statTag).toBe("Success");   // guard (c) does NOT catch it
    });
});
