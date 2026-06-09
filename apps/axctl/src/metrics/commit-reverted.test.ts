import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeRevertedCommits } from "./commit-reverted.ts";
import { SurrealClient } from "@ax/lib/db";
import { stableDigest } from "@ax/lib/ids";

interface MockOpts {
    readonly commits?: Array<Record<string, unknown>>;
    readonly touched?: Array<Record<string, unknown>>;
    readonly existingTrue?: string[]; // VALUE type::string(id) of currently-reverted commits
    readonly commitCount?: number;
    readonly maxTs?: string | null;
    readonly touchedCount?: number;
    readonly currentRevertedCount?: number;
    readonly storedSha?: string;
}

// Precise router so the watermark UPSERT and the reverted UPDATEs land in
// separate sinks, and the fingerprint/skip queries are distinguishable.
const makeDb = (opts: MockOpts) => {
    const reverts: string[] = [];
    const ok = <T>(rows: unknown): T => [rows] as unknown as T;
    const layer = Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/UPDATE .*SET reverted/.test(sql)) { reverts.push(sql); return Effect.succeed(ok<T>([])); }
            if (/UPSERT ingest_file_state/.test(sql)) return Effect.succeed(ok<T>([]));
            if (/SELECT sha FROM ingest_file_state/.test(sql)) {
                return Effect.succeed(ok<T>(opts.storedSha !== undefined ? [{ sha: opts.storedSha }] : []));
            }
            if (/count\(\) AS n FROM commit WHERE reverted = true/.test(sql)) {
                return Effect.succeed(ok<T>([{ n: opts.currentRevertedCount ?? 0 }]));
            }
            if (/count\(\) AS c, type::string\(math::max\(ts\)\) AS m FROM commit/.test(sql)) {
                return Effect.succeed(ok<T>([{ c: opts.commitCount ?? 0, m: opts.maxTs ?? null }]));
            }
            if (/count\(\) AS c FROM touched/.test(sql)) {
                return Effect.succeed(ok<T>([{ c: opts.touchedCount ?? 0 }]));
            }
            if (/SELECT VALUE type::string\(id\) FROM commit WHERE reverted = true/.test(sql)) {
                return Effect.succeed(ok<T>(opts.existingTrue ?? []));
            }
            if (/FROM commit/.test(sql)) return Effect.succeed(ok<T>(opts.commits ?? []));
            if (/FROM touched/.test(sql)) return Effect.succeed(ok<T>(opts.touched ?? []));
            return Effect.succeed(ok<T>([]));
        },
    } as never);
    return { layer, reverts };
};

const fingerprintOf = (commitCount: number, maxTs: string, touchedCount: number): string =>
    stableDigest(`${commitCount}|${maxTs}|${touchedCount}`, 32);

describe("computeRevertedCommits", () => {
    test("marks the feature commit of a fix chain reverted=true; returns it as a changed key", async () => {
        const commits = [
            { id: "commit:`featAAA`", message: "add login", repository: "repository:`r`", ts: "2026-01-01T00:00:00Z" },
            { id: "commit:`fixBBB`", message: "fix login bug", repository: "repository:`r`", ts: "2026-01-08T00:00:00Z" },
        ];
        const touched = [
            { in: "commit:`featAAA`", out: "file:`x`", path: "login.ts" },
            { in: "commit:`fixBBB`", out: "file:`x`", path: "login.ts" },
        ];
        const { layer, reverts } = makeDb({ commits, touched, existingTrue: [], commitCount: 2, maxTs: "z", touchedCount: 2, storedSha: "STALE" });
        const result = await Effect.runPromise(computeRevertedCommits().pipe(Effect.provide(layer)));
        expect(result.skipped).toBe(false);
        expect(result.revertedCount).toBe(1);
        expect(result.changedKeys).toEqual(["featAAA"]);
        expect(reverts.some((s) => /featAAA.*SET reverted = true/.test(s))).toBe(true);
    });

    test("the full-history commit load is unwindowed (no since/WHERE/ts filter)", async () => {
        const captured: string[] = [];
        const layer = Layer.succeed(SurrealClient, {
            query: <T>(sql: string) => { captured.push(sql); return Effect.succeed([[]] as unknown as T); },
        } as never);
        await Effect.runPromise(computeRevertedCommits().pipe(Effect.provide(layer)));
        const fullLoad = captured.find((s) => /SELECT id, message, repository/.test(s));
        expect(fullLoad).toBeDefined();
        expect(fullLoad!).not.toMatch(/ts\s*>|since|WHERE/i);
    });

    test("skips the full-history scan when the commit-graph fingerprint is unchanged", async () => {
        const captured: string[] = [];
        const sha = fingerprintOf(5, "2026-01-01T00:00:00Z", 9);
        const layer = Layer.succeed(SurrealClient, {
            query: <T>(sql: string) => {
                captured.push(sql);
                if (/SELECT sha FROM ingest_file_state/.test(sql)) return Effect.succeed([[{ sha }]] as unknown as T);
                if (/count\(\) AS n FROM commit WHERE reverted = true/.test(sql)) return Effect.succeed([[{ n: 3 }]] as unknown as T);
                if (/count\(\) AS c, type::string\(math::max\(ts\)\) AS m FROM commit/.test(sql)) {
                    return Effect.succeed([[{ c: 5, m: "2026-01-01T00:00:00Z" }]] as unknown as T);
                }
                if (/count\(\) AS c FROM touched/.test(sql)) return Effect.succeed([[{ c: 9 }]] as unknown as T);
                return Effect.succeed([[]] as unknown as T);
            },
        } as never);
        const result = await Effect.runPromise(computeRevertedCommits().pipe(Effect.provide(layer)));
        expect(result.skipped).toBe(true);
        expect(result.revertedCount).toBe(3);
        expect(result.changedKeys).toEqual([]);
        // No full-history load, no UPDATEs when skipped.
        expect(captured.some((s) => /SELECT id, message, repository/.test(s))).toBe(false);
        expect(captured.some((s) => /UPDATE .*SET reverted/.test(s))).toBe(false);
    });

    test("no diff → no reverted UPDATEs (watermark upsert is not counted as a flip)", async () => {
        const commits = [
            { id: "commit:`featAAA`", message: "add login", repository: "repository:`r`", ts: "2026-01-01T00:00:00Z" },
            { id: "commit:`fixBBB`", message: "fix login bug", repository: "repository:`r`", ts: "2026-01-08T00:00:00Z" },
        ];
        const touched = [
            { in: "commit:`featAAA`", out: "file:`x`", path: "login.ts" },
            { in: "commit:`fixBBB`", out: "file:`x`", path: "login.ts" },
        ];
        // featAAA is ALREADY reverted=true → revertedKeys == existing → empty diff.
        const { layer, reverts } = makeDb({ commits, touched, existingTrue: ["commit:`featAAA`"], commitCount: 2, maxTs: "z", touchedCount: 2, storedSha: "STALE" });
        const result = await Effect.runPromise(computeRevertedCommits().pipe(Effect.provide(layer)));
        expect(result.skipped).toBe(false);
        expect(reverts.length).toBe(0);
        expect(result.changedKeys).toEqual([]);
    });
});
