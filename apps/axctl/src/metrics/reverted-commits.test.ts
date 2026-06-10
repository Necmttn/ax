import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { fetchSessionDurabilityDetail } from "./reverted-commits.ts";

const SID = "019e0ad4-c977-7ab8-0000-000000000001";

/** Dispatching mock: produced-edge query vs later_fixed_by query. */
const db = (
    produced: Array<Record<string, unknown>>,
    fixes: Array<Record<string, unknown>> = [],
    capture?: { sqls: string[] },
) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            capture?.sqls.push(sql);
            if (sql.includes("FROM later_fixed_by")) return Effect.succeed([fixes] as unknown as T);
            return Effect.succeed([produced] as unknown as T);
        },
    } as never);

const featureRow = {
    commit: "commit:`feat_key`",
    sha: "92417acaeaa7afcee3f7b61cc89f4b02373aa5f8",
    message: "feat: add widget",
    ts: "2026-05-25T02:13:28Z",
    reverted: true,
};
const durableRow = {
    commit: "commit:`durable_key`",
    sha: "1111111aaaaaaa1111111aaaaaaa1111111aaaaa",
    message: "chore: keep me",
    ts: "2026-05-25T03:00:00Z",
    reverted: null,
};
const fixRow = {
    feature: "commit:`feat_key`",
    fix: "commit:`fix_key`",
    fix_sha: "134bd7bd67f2177c134bd7bd67f2177c134bd7bd",
    fix_message: "fix: widget broke",
    fix_ts: "2026-05-26T08:00:00Z",
    days_between: 1.24,
    confidence: "high",
};

describe("fetchSessionDurabilityDetail", () => {
    test("invalid session id → null (no query issued)", async () => {
        const capture = { sqls: [] as string[] };
        const out = await Effect.runPromise(
            fetchSessionDurabilityDetail("not a valid id!").pipe(Effect.provide(db([], [], capture))),
        );
        expect(out).toBeNull();
        expect(capture.sqls).toHaveLength(0);
    });

    test("no produced commits → ratio null (unknown, not 0)", async () => {
        const out = await Effect.runPromise(
            fetchSessionDurabilityDetail(SID).pipe(Effect.provide(db([]))),
        );
        expect(out).toEqual({
            producedCommits: 0,
            revertedCommits: 0,
            durabilityRatio: null,
            reverted: [],
        });
    });

    test("reverted commit resolves its later_fixed_by fix chain", async () => {
        const out = await Effect.runPromise(
            fetchSessionDurabilityDetail(SID).pipe(Effect.provide(db([featureRow, durableRow], [fixRow]))),
        );
        expect(out).not.toBeNull();
        expect(out!.producedCommits).toBe(2);
        expect(out!.revertedCommits).toBe(1);
        expect(out!.durabilityRatio).toBeCloseTo(0.5, 8);
        expect(out!.reverted).toHaveLength(1);
        const reverted = out!.reverted[0]!;
        expect(reverted.sha).toBe(featureRow.sha);
        expect(reverted.message).toBe("feat: add widget");
        expect(reverted.fixes).toHaveLength(1);
        expect(reverted.fixes[0]).toEqual({
            commitId: "commit:`fix_key`",
            sha: fixRow.fix_sha,
            message: "fix: widget broke",
            ts: "2026-05-26T08:00:00Z",
            daysBetween: 1.24,
            confidence: "high",
        });
    });

    test("reverted commit with no fix edge keeps empty fixes (window-bounded later_fixed_by)", async () => {
        const out = await Effect.runPromise(
            fetchSessionDurabilityDetail(SID).pipe(Effect.provide(db([featureRow], []))),
        );
        expect(out!.reverted[0]!.fixes).toEqual([]);
        expect(out!.durabilityRatio).toBe(0);
    });

    test("queries are anchored on the session's produced edges (bounded, no graph-wide walk)", async () => {
        const capture = { sqls: [] as string[] };
        await Effect.runPromise(
            fetchSessionDurabilityDetail(SID).pipe(Effect.provide(db([featureRow], [fixRow], capture))),
        );
        expect(capture.sqls).toHaveLength(2);
        expect(capture.sqls[0]).toContain(`FROM produced WHERE in = session:⟨${SID}⟩`);
        expect(capture.sqls[0]).toContain("LIMIT 200");
        expect(capture.sqls[1]).toContain("FROM later_fixed_by WHERE in IN [commit:`feat_key`]");
    });

    test("duplicate produced edges for one commit are de-duplicated", async () => {
        const out = await Effect.runPromise(
            fetchSessionDurabilityDetail(SID).pipe(Effect.provide(db([featureRow, featureRow], [fixRow]))),
        );
        expect(out!.producedCommits).toBe(1);
        expect(out!.revertedCommits).toBe(1);
    });

    test("skips the fix query entirely when nothing was reverted", async () => {
        const capture = { sqls: [] as string[] };
        const out = await Effect.runPromise(
            fetchSessionDurabilityDetail(SID).pipe(Effect.provide(db([durableRow], [], capture))),
        );
        expect(out!.durabilityRatio).toBe(1);
        expect(capture.sqls).toHaveLength(1);
    });
});
