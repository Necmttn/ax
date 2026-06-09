import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeRevertedCommits } from "./commit-reverted.ts";
import { SurrealClient } from "@ax/lib/db";

const makeDb = (rows: Record<string, unknown[]>, sink: string[]) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/UPDATE/.test(sql)) { sink.push(sql); return Effect.succeed([[]] as unknown as T); }
            // The existing-true load must be matched BEFORE the generic
            // `FROM commit` (it also contains `FROM commit`).
            if (/reverted = true/.test(sql)) return Effect.succeed([rows.existing ?? []] as unknown as T);
            if (/FROM commit/.test(sql)) return Effect.succeed([rows.commit ?? []] as unknown as T);
            if (/FROM touched/.test(sql)) return Effect.succeed([rows.touched ?? []] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

const fixChainRows = (existing: string[]) => ({
    commit: [
        { id: "commit:`featAAA`", message: "add login", repository: "repository:`r`", ts: "2026-01-01T00:00:00Z" },
        { id: "commit:`fixBBB`", message: "fix login bug", repository: "repository:`r`", ts: "2026-01-08T00:00:00Z" },
    ],
    touched: [
        { in: "commit:`featAAA`", out: "file:`x`", path: "login.ts" },
        { in: "commit:`fixBBB`", out: "file:`x`", path: "login.ts" },
    ],
    existing,
});

describe("computeRevertedCommits", () => {
    test("marks the feature commit of a fix chain reverted=true over FULL history", async () => {
        const sink: string[] = [];
        // Nothing currently true → toTrue diff fires for the feature commit.
        const result = await Effect.runPromise(
            computeRevertedCommits().pipe(Effect.provide(makeDb(fixChainRows([]), sink))),
        );
        expect(result.revertedCount).toBe(1);
        expect(sink.some((s) => /featAAA.*SET reverted = true/.test(s))).toBe(true);
    });

    test("no redundant UPDATE when the feature commit is already reverted=true", async () => {
        const sink: string[] = [];
        // Existing true-set already contains the feature commit → empty diff.
        const result = await Effect.runPromise(
            computeRevertedCommits().pipe(Effect.provide(makeDb(fixChainRows(["commit:`featAAA`"]), sink))),
        );
        expect(result.revertedCount).toBe(1);
        // No UPDATE statements at all (diff is empty on both sides).
        expect(sink.length).toBe(0);
    });

    test("commit load has no since/window clause (full history)", async () => {
        const captured: string[] = [];
        const db = Layer.succeed(SurrealClient, {
            query: <T>(sql: string) => { captured.push(sql); return Effect.succeed([[]] as unknown as T); },
        } as never);
        await Effect.runPromise(computeRevertedCommits().pipe(Effect.provide(db)));
        const commitLoad = captured.find((s) => /FROM commit/.test(s) && !/reverted = true/.test(s));
        expect(commitLoad).toBeDefined();
        expect(commitLoad!).not.toMatch(/ts\s*>|since|WHERE/i);
    });
});
