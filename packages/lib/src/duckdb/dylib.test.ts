import { afterAll, describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDylib, isEmbeddedPath, resolveDylibPath } from "./dylib.ts";

// Finding 4 (final fix round): every dir this suite creates is collected here
// and removed in one afterAll - `mkdtempSync` with no cleanup was leaking
// +43 dirs / +10 MB per full duckdb suite run (1,784 dirs / 670 MB measured
// on the reviewer's machine). `force: true` tolerates a dir already gone.
const createdTempDirs: string[] = [];
const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-dylib-"));
    createdTempDirs.push(dir);
    return dir;
};

afterAll(() => {
    for (const dir of createdTempDirs) rmSync(dir, { recursive: true, force: true });
});

/** RULING R6: both effects need `FileSystem.FileSystem` - run every call
 *  through `BunFileSystem.layer`. */
const runWithFs = <A, E>(eff: Effect.Effect<A, E, import("effect").FileSystem.FileSystem>) =>
    Effect.runPromise(eff.pipe(Effect.provide(BunFileSystem.layer)));

describe("isEmbeddedPath", () => {
    test("recognises the compiled-binary virtual filesystem", () => {
        expect(isEmbeddedPath("/$bunfs/root/libduckdb.dylib")).toBe(true);
        expect(isEmbeddedPath("B:/~BUN/root/libduckdb.dylib")).toBe(true);
        expect(isEmbeddedPath("/Users/x/vendor/libduckdb.dylib")).toBe(false);
    });
});

describe("extractDylib", () => {
    test("writes the bytes to a content-hash path under the cache dir", async () => {
        const dir = tempDir();
        const source = join(dir, "src.bin");
        await Bun.write(source, "duckdb-bytes");
        const cache = join(dir, "cache");

        const out = await runWithFs(extractDylib(source, cache));

        expect(out.startsWith(cache)).toBe(true);
        expect(existsSync(out)).toBe(true);
        expect(await Bun.file(out).text()).toBe("duckdb-bytes");
    });

    test("different bytes land on different paths", async () => {
        const dir = tempDir();
        const cache = join(dir, "cache");
        const a = join(dir, "a.bin");
        const b = join(dir, "b.bin");
        await Bun.write(a, "aaaa");
        await Bun.write(b, "bbbb");

        expect(await runWithFs(extractDylib(a, cache))).not.toBe(await runWithFs(extractDylib(b, cache)));
    });

    test("reuses an already-extracted file instead of rewriting it", async () => {
        const dir = tempDir();
        const cache = join(dir, "cache");
        const source = join(dir, "src.bin");
        await Bun.write(source, "duckdb-bytes");

        const first = await runWithFs(extractDylib(source, cache));
        const firstMtime = statSync(first).mtimeMs;
        await Bun.sleep(15);
        const second = await runWithFs(extractDylib(source, cache));

        expect(second).toBe(first);
        expect(statSync(second).mtimeMs).toBe(firstMtime);
        // The reuse path must never leave a staging file behind either.
        expect(readdirSync(cache).length).toBe(1);
    });

    test("creates the cache dir owner-only (0700) and publishes the dylib read-only (0400)", async () => {
        const dir = tempDir();
        const cache = join(dir, "cache");
        const source = join(dir, "src.bin");
        await Bun.write(source, "duckdb-bytes");

        const out = await runWithFs(extractDylib(source, cache));

        // No group/other permissions on the cache dir; owner-read-only on the file.
        expect(statSync(cache).mode & 0o077).toBe(0);
        expect(statSync(out).mode & 0o777).toBe(0o400);
    });

    test("rejects a tampered cache file and re-extracts the trusted bytes (adversarial P2)", async () => {
        const dir = tempDir();
        const cache = join(dir, "cache");
        const source = join(dir, "src.bin");
        await Bun.write(source, "trusted-duckdb-bytes");

        const out = await runWithFs(extractDylib(source, cache));
        expect(await Bun.file(out).text()).toBe("trusted-duckdb-bytes");

        // A same-user attacker plants a malicious library at the predictable
        // content-hash path (the file is published 0400, so make it writable
        // first, as an attacker with the same uid could).
        chmodSync(out, 0o600);
        await Bun.write(out, "MALICIOUS-PAYLOAD");
        expect(await Bun.file(out).text()).toBe("MALICIOUS-PAYLOAD");

        // The next resolve must NOT dlopen the tampered bytes: it re-hashes the
        // on-disk file, sees the mismatch, and re-extracts the trusted bytes.
        const second = await runWithFs(extractDylib(source, cache));
        expect(second).toBe(out);
        expect(await Bun.file(out).text()).toBe("trusted-duckdb-bytes");
        // Republished read-only again.
        expect(statSync(out).mode & 0o777).toBe(0o400);
    });
});

describe("resolveDylibPath", () => {
    test("prefers AX_DUCKDB_DYLIB when it exists", async () => {
        const dir = tempDir();
        const injected = join(dir, "injected.dylib");
        await Bun.write(injected, "x");
        const prev = process.env.AX_DUCKDB_DYLIB;
        process.env.AX_DUCKDB_DYLIB = injected;
        try {
            expect(await runWithFs(resolveDylibPath())).toBe(injected);
        } finally {
            if (prev === undefined) delete process.env.AX_DUCKDB_DYLIB;
            else process.env.AX_DUCKDB_DYLIB = prev;
        }
    });

    test("returns a real on-disk asset path unchanged (source mode)", async () => {
        const dir = tempDir();
        const asset = join(dir, "libduckdb.dylib");
        await Bun.write(asset, "x");
        const prev = process.env.AX_DUCKDB_DYLIB;
        delete process.env.AX_DUCKDB_DYLIB;
        try {
            expect(await runWithFs(resolveDylibPath({ assetPath: asset }))).toBe(asset);
        } finally {
            if (prev !== undefined) process.env.AX_DUCKDB_DYLIB = prev;
        }
    });

    test("fails with a typed error when nothing resolves", async () => {
        const dir = tempDir();
        const prev = process.env.AX_DUCKDB_DYLIB;
        delete process.env.AX_DUCKDB_DYLIB;
        try {
            // effect@4 beta: `Effect.either` is gone; `Effect.result` produces
            // a `Result` (`_tag: "Success" | "Failure"`, not Either's Left/Right).
            const result = await runWithFs(
                Effect.result(resolveDylibPath({ assetPath: join(dir, "missing.dylib") })),
            );
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") expect(result.failure._tag).toBe("DuckDbDylibError");
        } finally {
            if (prev !== undefined) process.env.AX_DUCKDB_DYLIB = prev;
        }
    });
});
