import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeRevertedCommits } from "./commit-reverted.ts";
import { SurrealClient } from "@ax/lib/db";

const makeDb = (rows: Record<string, unknown[]>, sink: string[]) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/UPSERT|UPDATE/.test(sql)) { sink.push(sql); return Effect.succeed([[]] as unknown as T); }
            if (/FROM commit/.test(sql)) return Effect.succeed([rows.commit ?? []] as unknown as T);
            if (/FROM touched/.test(sql)) return Effect.succeed([rows.touched ?? []] as unknown as T);
            if (/FROM session_health/.test(sql)) return Effect.succeed([rows.health ?? []] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

describe("computeRevertedCommits", () => {
    test("marks the feature commit of a fix chain reverted=true over FULL history", async () => {
        const sink: string[] = [];
        const rows = {
            commit: [
                { id: "commit:`featAAA`", message: "add login", repository: "repository:`r`", ts: "2026-01-01T00:00:00Z" },
                { id: "commit:`fixBBB`", message: "fix login bug", repository: "repository:`r`", ts: "2026-01-08T00:00:00Z" },
            ],
            touched: [
                { in: "commit:`featAAA`", out: "file:`x`", path: "login.ts" },
                { in: "commit:`fixBBB`", out: "file:`x`", path: "login.ts" },
            ],
            health: [],
        };
        const result = await Effect.runPromise(computeRevertedCommits().pipe(Effect.provide(makeDb(rows, sink))));
        expect(result.revertedCount).toBeGreaterThanOrEqual(0);
        expect(sink.some((s) => /reverted = true|reverted: true/.test(s))).toBe(true);
    });

    test("commit load has no since/window clause (full history)", async () => {
        const captured: string[] = [];
        const db = Layer.succeed(SurrealClient, {
            query: <T>(sql: string) => { captured.push(sql); return Effect.succeed([[]] as unknown as T); },
        } as never);
        await Effect.runPromise(computeRevertedCommits().pipe(Effect.provide(db)));
        const commitLoad = captured.find((s) => /FROM commit/.test(s));
        expect(commitLoad).toBeDefined();
        expect(commitLoad!).not.toMatch(/ts\s*>|since|WHERE/i);
    });
});
