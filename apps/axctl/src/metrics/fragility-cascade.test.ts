import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { localPathFileRecordKey } from "@ax/lib/ids";
import {
    DEFAULT_FRAGILITY_LIMITS,
    computeFragilityCascade,
    deriveFragilityCascade,
    joinCascadeEdges,
    localPathTwinKeys,
    persistFragilityCascade,
    readFragilityCascade,
    type CascadeEdge,
    type FragilityLimits,
} from "./fragility-cascade.ts";
import { SurrealClient } from "@ax/lib/db";

// Bounded queries, routed by their FROM clause. Mutating statements (DELETE /
// UPSERT fragility_cascade) land in `sink`.
interface Fixture {
    commits?: Array<Record<string, unknown>>;
    checkouts?: Array<Record<string, unknown>>;
    touched?: Array<Record<string, unknown>>;
    files?: Array<Record<string, unknown>>;
    produced?: Array<Record<string, unknown>>;
    edited?: Array<Record<string, unknown>>;
    cascadeRows?: Array<Record<string, unknown>>;
    sink?: string[];
}

const db = (fx: Fixture) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/DELETE fragility_cascade|UPSERT fragility_cascade/.test(sql)) {
                fx.sink?.push(...sql.split("\n").filter((s) => s.length > 0));
                return Effect.succeed([[]] as unknown as T);
            }
            if (/FROM fragility_cascade/.test(sql)) return Effect.succeed([fx.cascadeRows ?? []] as unknown as T);
            if (/FROM commit WHERE reverted = true/.test(sql)) return Effect.succeed([fx.commits ?? []] as unknown as T);
            if (/FROM checkout/.test(sql)) return Effect.succeed([fx.checkouts ?? []] as unknown as T);
            if (/FROM touched/.test(sql)) return Effect.succeed([fx.touched ?? []] as unknown as T);
            // file-info fetch is a record-list selection: SELECT ... FROM [file:`a`, ...]
            if (/FROM \[file:/.test(sql)) return Effect.succeed([fx.files ?? []] as unknown as T);
            if (/FROM produced/.test(sql)) return Effect.succeed([fx.produced ?? []] as unknown as T);
            if (/FROM edited/.test(sql)) return Effect.succeed([fx.edited ?? []] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>, fx: Fixture): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(db(fx))));

const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";

describe("localPathTwinKeys", () => {
    test("derives the SAME key tool-call ingest writes for <root>/<relPath>", () => {
        const twins = localPathTwinKeys("src/index.ts", ["/Users/u/proj", "/Users/u/proj/.claude/worktrees/w1"]);
        expect(twins).toEqual([
            localPathFileRecordKey("/Users/u/proj/src/index.ts"),
            localPathFileRecordKey("/Users/u/proj/.claude/worktrees/w1/src/index.ts"),
        ]);
        // The local-path namespace prefix existing rows live under.
        expect(twins[0].startsWith("repository__")).toBe(true);
    });

    test("tolerates a trailing slash on the checkout root", () => {
        expect(localPathTwinKeys("a.ts", ["/repo/"])).toEqual([localPathFileRecordKey("/repo/a.ts")]);
    });
});

describe("computeFragilityCascade (cross-namespace bridge)", () => {
    // THE issue #171 regression: touched points at a git-scoped file
    // (file:remote_*, relative path) while edited points at the tool-call
    // local-path twin (file:repository__*, absolute path). Disjoint keys,
    // joined via the checkout root.
    test("joins git-touched files to tool-call edits via the checkout-root twin key", async () => {
        const twin = localPathFileRecordKey("/repo/src/a.ts");
        const fx: Fixture = {
            commits: [{ id: "commit:remote_r__c1" }],
            checkouts: [{ repository: "repository:remote_r", path: "/repo" }],
            touched: [{ commit: "commit:remote_r__c1", file: "file:remote_r__src_a_ts", ts: T0 }],
            files: [{ id: "file:remote_r__src_a_ts", path: "src/a.ts", repository: "repository:remote_r" }],
            produced: [{ commit: "commit:remote_r__c1", session: "session:`A`" }],
            edited: [{ file: `file:${twin}`, session: "session:`B`", ts: T1 }],
        };
        const edges = await run(computeFragilityCascade(), fx);
        expect(edges).toEqual([{ origin: "session:`A`", downstream: "session:`B`", weight: 1 }]);
    });

    test("origin→downstream edges weighted by distinct downstream fixers (direct keys)", async () => {
        const fx: Fixture = {
            commits: [{ id: "commit:`C`" }],
            checkouts: [],
            touched: [
                { commit: "commit:`C`", file: "file:`f1`", ts: T0 },
                { commit: "commit:`C`", file: "file:`f2`", ts: T0 },
            ],
            files: [
                { id: "file:`f1`", path: "f1", repository: null },
                { id: "file:`f2`", path: "f2", repository: null },
            ],
            produced: [{ commit: "commit:`C`", session: "session:`A`" }],
            edited: [
                { file: "file:`f1`", session: "session:`B`", ts: T1 },
                { file: "file:`f2`", session: "session:`B`", ts: T1 }, // same pair, 2nd file
                { file: "file:`f1`", session: "session:`C`", ts: T1 },
            ],
        };
        const edges = await run(computeFragilityCascade(), fx);
        const a = edges.filter((e: CascadeEdge) => e.origin === "session:`A`");
        expect(new Set(a.map((e) => e.downstream))).toEqual(new Set(["session:`B`", "session:`C`"]));
        expect(a.length).toBe(2); // deduped to distinct (origin,downstream) pairs
        expect(a.every((e) => e.weight === 2)).toBe(true); // distinct downstreams {B,C}=2
    });

    test("excludes the origin's own later edits and edits at/before the touch ts", async () => {
        const fx: Fixture = {
            commits: [{ id: "commit:`C`" }],
            touched: [{ commit: "commit:`C`", file: "file:`f1`", ts: T1 }],
            files: [{ id: "file:`f1`", path: "f1", repository: null }],
            produced: [{ commit: "commit:`C`", session: "session:`A`" }],
            edited: [
                { file: "file:`f1`", session: "session:`A`", ts: "2026-01-03T00:00:00Z" }, // origin itself → excluded
                { file: "file:`f1`", session: "session:`B`", ts: T0 }, // before touch ts → excluded
                { file: "file:`f1`", session: "session:`B`", ts: T1 }, // at touch ts (<=) → excluded
            ],
        };
        const edges = await run(computeFragilityCascade(), fx);
        expect(edges).toEqual([]);
    });

    test("no reverted commits → no edges (and no downstream queries needed)", async () => {
        const edges = await run(computeFragilityCascade(), {});
        expect(edges).toEqual([]);
    });

    test("skips mass reverts: a commit touching more than maxFilesPerCommit files yields nothing", async () => {
        const limits: FragilityLimits = { ...DEFAULT_FRAGILITY_LIMITS, maxFilesPerCommit: 1 };
        const fx: Fixture = {
            commits: [{ id: "commit:`C`" }],
            touched: [
                { commit: "commit:`C`", file: "file:`f1`", ts: T0 },
                { commit: "commit:`C`", file: "file:`f2`", ts: T0 },
            ],
            files: [
                { id: "file:`f1`", path: "f1", repository: null },
                { id: "file:`f2`", path: "f2", repository: null },
            ],
            produced: [{ commit: "commit:`C`", session: "session:`A`" }],
            edited: [{ file: "file:`f1`", session: "session:`B`", ts: T1 }],
        };
        expect(await run(computeFragilityCascade(limits), fx)).toEqual([]);
    });

    test("dedupes per-checkout touched duplicates so the file cap counts DISTINCT files", async () => {
        const limits: FragilityLimits = { ...DEFAULT_FRAGILITY_LIMITS, maxFilesPerCommit: 1 };
        const fx: Fixture = {
            commits: [{ id: "commit:`C`" }],
            // Same (commit, file) via two checkouts - must count as ONE file.
            touched: [
                { commit: "commit:`C`", file: "file:`f1`", ts: T0 },
                { commit: "commit:`C`", file: "file:`f1`", ts: T0 },
            ],
            files: [{ id: "file:`f1`", path: "f1", repository: null }],
            produced: [{ commit: "commit:`C`", session: "session:`A`" }],
            edited: [{ file: "file:`f1`", session: "session:`B`", ts: T1 }],
        };
        const edges = await run(computeFragilityCascade(limits), fx);
        expect(edges).toEqual([{ origin: "session:`A`", downstream: "session:`B`", weight: 1 }]);
    });

    test("anchor query carries the maxRevertedCommits LIMIT", async () => {
        const seen: string[] = [];
        const layer = Layer.succeed(SurrealClient, {
            query: <T>(sql: string) => {
                seen.push(sql);
                return Effect.succeed([[]] as unknown as T);
            },
        } as never);
        await Effect.runPromise(
            computeFragilityCascade({ ...DEFAULT_FRAGILITY_LIMITS, maxRevertedCommits: 123 }).pipe(
                Effect.provide(layer),
            ),
        );
        expect(seen.some((s) => /FROM commit WHERE reverted = true ORDER BY ts DESC LIMIT 123;/.test(s))).toBe(true);
    });
});

describe("joinCascadeEdges (pure)", () => {
    test("caps weight at distinct downstream sessions per origin", () => {
        const edges = joinCascadeEdges(
            [
                { commit: "c1", file: "f1", ts: 0 },
                { commit: "c1", file: "f2", ts: 0 },
            ],
            new Map([["c1", "A"]]),
            new Map([
                ["f1", [{ session: "B", ts: 1 }, { session: "B", ts: 2 }]],
                ["f2", [{ session: "C", ts: 1 }]],
            ]),
        );
        expect(edges.length).toBe(2);
        expect(edges.every((e) => e.weight === 2)).toBe(true);
    });
});

describe("persist + read (derive-stage precompute)", () => {
    test("persistFragilityCascade rewrites the table: DELETE then keyed UPSERTs", async () => {
        const sink: string[] = [];
        const written = await run(
            persistFragilityCascade([
                { origin: "session:`A`", downstream: "session:`B`", weight: 2 },
                { origin: "session:⟨a-b-c⟩", downstream: "session:`D`", weight: 1 },
            ]),
            { sink },
        );
        expect(written).toBe(2);
        const all = sink.join("\n");
        expect(all).toContain("DELETE fragility_cascade;");
        expect(all).toContain("origin: session:`A`, downstream: session:`B`, weight: 2");
        // ⟨⟩-wrapped (uuid-style) ids are unwrapped then re-quoted safely.
        expect(all).toContain("origin: session:`a-b-c`, downstream: session:`D`, weight: 1");
        expect(/UPSERT fragility_cascade:`[0-9a-f]{16}` CONTENT/.test(all)).toBe(true);
    });

    test("deriveFragilityCascade computes then persists (empty → only the DELETE)", async () => {
        const sink: string[] = [];
        const written = await run(deriveFragilityCascade(), { sink });
        expect(written).toBe(0);
        expect(sink.join("\n")).toContain("DELETE fragility_cascade;");
    });

    test("readFragilityCascade maps stored rows to CascadeEdge", async () => {
        const edges = await run(readFragilityCascade(), {
            cascadeRows: [
                { origin: "session:`A`", downstream: "session:`B`", weight: 3 },
                { origin: null, downstream: "session:`B`", weight: 1 }, // malformed → dropped
            ],
        });
        expect(edges).toEqual([{ origin: "session:`A`", downstream: "session:`B`", weight: 3 }]);
    });
});
