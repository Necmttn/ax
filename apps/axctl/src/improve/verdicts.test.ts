/**
 * The verdict read model over a REAL temporary sidecar built from the
 * production DDL: history stays, unsafe current recommendations do not.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Judgment, JudgmentLayer } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { listVerdicts, showVerdict } from "./verdicts.ts";

const CREATED_AT = new Date("2026-01-01T00:00:00Z");
const INSTALLED_AT = new Date("2026-01-10T00:00:00Z");

const measured = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    opportunities: 12, addressed: 8, ratio: 8 / 12, built: true,
    measurement_status: "measured", measurement_version: 2,
    ...overrides,
});

interface Seed {
    readonly sig: string;
    readonly status?: string;
    readonly experimentStatus?: string;
    readonly lockedVerdict?: string | null;
    readonly checkpoints?: ReadonlyArray<{
        readonly kind: string;
        readonly suggested: string | null;
        readonly measured: string;
        readonly userVerdict?: string | null;
        readonly observedAt: Date;
    }>;
}

const withSidecar = <A>(seeds: ReadonlyArray<Seed>, body: Effect.Effect<A, unknown, Judgment>) => {
    const sidecarPath = join(mkdtempSync(join(tmpdir(), "ax-verdicts-")), "judgment.sqlite");
    return Effect.runPromise(Effect.gen(function* () {
        const judgment = yield* Judgment;
        for (const seed of seeds) {
            yield* judgment.put("proposal", {
                id: `proposal-${seed.sig}`, form: "guidance", title: `T-${seed.sig}`,
                hypothesis: "H", dedupe_sig: seed.sig, frequency: 3, confidence: "high",
                status: seed.status ?? "accepted", origin: "agent", hypothesis_template: null,
                evidence_query: null, reject_reason: null, baseline: null,
                created_at: CREATED_AT, updated_at: CREATED_AT,
            });
            yield* judgment.put("experiment", {
                id: `experiment-${seed.sig}`, proposal: `proposal-${seed.sig}`, artifact: null,
                artifact_path: "/repo/CLAUDE.md", scaffolded_at: INSTALLED_AT, created_at: CREATED_AT,
                locked_verdict: seed.lockedVerdict ?? null,
                status: seed.experimentStatus ?? "scaffolded", task_path: null,
            });
            for (const checkpoint of seed.checkpoints ?? []) {
                yield* judgment.put("checkpoint", {
                    id: `checkpoint-${seed.sig}-${checkpoint.kind}`, experiment: `experiment-${seed.sig}`,
                    kind: checkpoint.kind, measured: checkpoint.measured, suggested: checkpoint.suggested,
                    user_verdict: checkpoint.userVerdict ?? null, observed_at: checkpoint.observedAt,
                });
            }
        }
        return yield* body;
    }).pipe(
        Effect.provide(JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL })),
        Effect.scoped,
    ) as Effect.Effect<A, unknown, never>);
};

const history = [
    {
        kind: "+3s", suggested: "adopted", measured: measured(),
        observedAt: new Date("2026-01-20T00:00:00Z"),
    },
    {
        kind: "+10s", suggested: null,
        measured: measured({
            opportunities: 0, addressed: 0, ratio: 0,
            measurement_status: "insufficient_data", reason: "no_opportunities",
        }),
        observedAt: new Date("2026-01-25T00:00:00Z"),
    },
] as const;

describe("listVerdicts", () => {
    test("projects the newest row, never an older positive suggestion", async () => {
        const rows = await withSidecar([{ sig: "sig-a", checkpoints: history }], listVerdicts());
        const row = rows[0] as Record<string, unknown>;
        const latest = row.latest_checkpoint as Record<string, unknown>;
        expect(latest.kind).toBe("+10s");
        expect(latest.suggested).toBeNull();
        expect(row.current_reason).toBe("no_opportunities");
    });

    test("suppresses the suggestion of an ineligible experiment and names its state", async () => {
        const rows = await withSidecar(
            [{ sig: "sig-b", experimentStatus: "retired", checkpoints: [history[0]] }],
            listVerdicts(),
        );
        const row = rows[0] as Record<string, unknown>;
        expect((row.latest_checkpoint as Record<string, unknown>).suggested).toBeNull();
        expect(row.current_reason).toBe("retired");
    });

    test("a locked experiment keeps the decision the human made", async () => {
        const rows = await withSidecar([{
            sig: "sig-c",
            lockedVerdict: "adopted",
            checkpoints: [{ ...history[0], userVerdict: "adopted" }],
        }], listVerdicts());
        const row = rows[0] as Record<string, unknown>;
        expect(row.locked_verdict).toBe("adopted");
        expect((row.latest_checkpoint as Record<string, unknown>).suggested).toBe("adopted");
        expect(row.current_reason).toBeNull();
    });

    test("no checkpoint yet reads as no_checkpoint", async () => {
        const rows = await withSidecar([{ sig: "sig-d" }], listVerdicts());
        const row = rows[0] as Record<string, unknown>;
        expect(row.latest_checkpoint).toBeNull();
        expect(row.current_reason).toBe("no_checkpoint");
    });
});

describe("showVerdict", () => {
    test("keeps the full history newest-first while the current view stays safe", async () => {
        const row = await withSidecar(
            [{ sig: "sig-a", checkpoints: history }],
            showVerdict("sig-a"),
        ) as Record<string, unknown>;
        const checkpoints = row.checkpoints as Array<Record<string, unknown>>;
        expect(checkpoints.map((c) => c.kind)).toEqual(["+10s", "+3s"]);
        // The stored history is untouched - the +3s row still reports what it
        // measured, and only the CURRENT projection withholds it.
        expect(checkpoints[1]!.suggested).toBe("adopted");
        expect((row.latest_checkpoint as Record<string, unknown>).suggested).toBeNull();
        expect(row.current_reason).toBe("no_opportunities");
    });

    test("a pre-version-2 row awaits refresh rather than recommending itself", async () => {
        const row = await withSidecar([{
            sig: "sig-legacy",
            checkpoints: [{
                kind: "+3s", suggested: "adopted",
                measured: JSON.stringify({ opportunities: 40, addressed: 39, ratio: 0.975, built: true }),
                observedAt: new Date("2026-01-20T00:00:00Z"),
            }],
        }], showVerdict("sig-legacy")) as Record<string, unknown>;
        expect((row.latest_checkpoint as Record<string, unknown>).suggested).toBeNull();
        expect(row.current_reason).toBe("refresh_required");
        expect((row.checkpoints as Array<Record<string, unknown>>)[0]!.suggested).toBe("adopted");
    });
});
