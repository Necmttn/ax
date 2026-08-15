import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { listProposals, type ProposalRow } from "./list.ts";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";

// Capture the SQL the function builds while returning seeded rows.
const capturing = (rows: ReadonlyArray<unknown>) => {
    const seen: string[] = [];
    const layer = judgmentTestLayer((sql) => {
            seen.push(sql);
            return rows.map((value) => ({
                ...(value as Record<string, unknown>),
                created_at: new Date(String((value as Record<string, unknown>).created_at)),
            }));
        });
    return { seen, layer };
};

const row = (over: Partial<ProposalRow> = {}): ProposalRow => ({
    id: "proposal:abc",
    form: "guidance",
    title: "T",
    hypothesis: "h",
    dedupe_sig: "sig",
    frequency: 1,
    confidence: "high",
    status: "open",
    created_at: "2026-05-20T00:00:00Z",
    ...over,
});

describe("listProposals", () => {
    test("default filters on status = open", async () => {
        const { seen, layer } = capturing([row()]);
        const out = await Effect.runPromise(
            listProposals({}).pipe(Effect.provide(layer)),
        );
        expect(out).toHaveLength(1);
        expect(seen[0]).toContain("WHERE status = ?");
        expect(seen[0]).toContain("ORDER BY frequency DESC, created_at DESC");
        expect(seen[0]).toContain("LIMIT ?");
        expect(seen[0]).toContain("FROM proposal");
    });

    test("status = all disables the status filter", async () => {
        const { seen, layer } = capturing([]);
        await Effect.runPromise(
            listProposals({ status: "all" }).pipe(Effect.provide(layer)),
        );
        expect(seen[0]).not.toContain("WHERE");
        expect(seen[0]).not.toContain("status =");
    });

    test("form filter is ANDed with status", async () => {
        const { seen, layer } = capturing([]);
        await Effect.runPromise(
            listProposals({ status: "accepted", form: "hook" }).pipe(Effect.provide(layer)),
        );
        expect(seen[0]).toContain("WHERE status = ? AND form = ?");
    });

    test("form filter alone (status all) yields WHERE form only", async () => {
        const { seen, layer } = capturing([]);
        await Effect.runPromise(
            listProposals({ status: "all", form: "guidance" }).pipe(Effect.provide(layer)),
        );
        expect(seen[0]).toContain("WHERE form = ?");
        expect(seen[0]).not.toContain("status =");
    });

    test("honors limit", async () => {
        const { seen, layer } = capturing([]);
        await Effect.runPromise(
            listProposals({ limit: 5 }).pipe(Effect.provide(layer)),
        );
        expect(seen[0]).toContain("LIMIT ?");
    });

    test("returns the first result page or empty array", async () => {
        const { layer } = capturing([row({ dedupe_sig: "a" }), row({ dedupe_sig: "b" })]);
        const out = await Effect.runPromise(
            listProposals({}).pipe(Effect.provide(layer)),
        );
        expect(out.map((r) => r.dedupe_sig)).toEqual(["a", "b"]);
    });
});
