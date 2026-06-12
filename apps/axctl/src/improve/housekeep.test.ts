import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import {
    buildExpireStatement,
    findStaleOpenProposals,
    runHousekeep,
} from "./housekeep.ts";

const makeDb = (rows: Array<Record<string, unknown>>, log: string[] = []) => {
    const stub: SurrealClientShape = {
        query: (sql: string) => {
            log.push(sql);
            return Effect.succeed([rows]);
        },
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

const staleRow = {
    id: "proposal:old",
    title: "Old idea",
    dedupe_sig: "sig-old",
    form: "skill",
    updated_at: "2026-05-01T00:00:00Z",
};

describe("buildExpireStatement", () => {
    test("supersedes only stale open proposals, with an explanatory reason", () => {
        const sql = buildExpireStatement(30);
        expect(sql).toContain("status = 'superseded'");
        expect(sql).toContain("status = 'open'");
        expect(sql).toContain("30d");
        expect(sql).toContain("housekeeping:");
        expect(sql).toContain("re-mined automatically");
    });
});

describe("findStaleOpenProposals", () => {
    test("returns rows from the stale select", async () => {
        const rows = await Effect.runPromise(
            findStaleOpenProposals(30).pipe(Effect.provide(makeDb([staleRow]))),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.dedupe_sig).toBe("sig-old");
    });
});

describe("runHousekeep", () => {
    test("dry run reports but never mutates", async () => {
        const log: string[] = [];
        const report = await Effect.runPromise(
            runHousekeep({ days: 30, dryRun: true, taskDir: "/tmp/nonexistent-ax-tasks" }).pipe(
                Effect.provide(makeDb([staleRow], log)),
            ),
        );
        expect(report.dryRun).toBe(true);
        expect(report.staleProposals).toHaveLength(1);
        expect(report.expired).toBe(0);
        expect(log.some((s) => s.includes("UPDATE proposal"))).toBe(false);
    });

    test("real run expires stale proposals", async () => {
        const log: string[] = [];
        const report = await Effect.runPromise(
            runHousekeep({ days: 30, dryRun: false, taskDir: "/tmp/nonexistent-ax-tasks" }).pipe(
                Effect.provide(makeDb([staleRow], log)),
            ),
        );
        expect(report.expired).toBe(1);
        expect(log.some((s) => s.includes("UPDATE proposal"))).toBe(true);
    });

    test("no stale rows -> no mutation query", async () => {
        const log: string[] = [];
        const report = await Effect.runPromise(
            runHousekeep({ days: 30, dryRun: false, taskDir: "/tmp/nonexistent-ax-tasks" }).pipe(
                Effect.provide(makeDb([], log)),
            ),
        );
        expect(report.expired).toBe(0);
        expect(log.filter((s) => s.includes("UPDATE proposal"))).toHaveLength(0);
    });
});
