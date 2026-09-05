import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { join } from "node:path";
import { CacheReadLayer, withCacheWrite } from "@ax/lib/duckdb/seam";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { WATERMARK_TABLE, watermarkRow } from "@ax/lib/duckdb/watermark";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { Judgment, JudgmentLayer, TextColumn, TimestampColumn } from "@ax/lib/sqlite";
import CACHE_DDL from "@ax/schema/schema.duckdb.sql" with { type: "text" };
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import {
    checkpointKey,
    computeSuggestedVerdict,
    deriveCheckpoints,
    dueCheckpointKinds,
} from "./derive-checkpoints.ts";
import {
    OPPORTUNITY_VERSION,
    OPPORTUNITY_VERSION_PATH,
    OPPORTUNITY_VERSION_SOURCE,
} from "./opportunity-cache-version.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("derive checkpoints");
const Platform = Layer.merge(BunFileSystem.layer, BunPath.layer);

describe("computeSuggestedVerdict", () => {
    test("zero opportunities is insufficient data, whatever the frequency delta says", () => {
        // Frequency equality never proved a pattern disappeared, and a rising
        // counter never proved the artifact was ignored (#1134).
        for (const frequencies of [
            {},
            { currentFrequency: 5, baselineFrequency: 5 },
            { currentFrequency: 9, baselineFrequency: 5 },
            { currentFrequency: 1, baselineFrequency: 9 },
        ]) {
            expect(computeSuggestedVerdict({
                opportunities: 0, addressed: 0, ratio: 0, built: true, ...frequencies,
            })).toBeNull();
        }
    });

    test("ratio > 0.6 -> adopted", () => {
        expect(computeSuggestedVerdict({ opportunities: 10, addressed: 7, ratio: 0.7, built: true })).toBe("adopted");
    });

    test("ratio < 0.1 -> ignored", () => {
        expect(computeSuggestedVerdict({ opportunities: 10, addressed: 0, ratio: 0, built: true })).toBe("ignored");
    });

    test("middling ratio -> partial", () => {
        expect(computeSuggestedVerdict({ opportunities: 10, addressed: 3, ratio: 0.3, built: true })).toBe("partial");
    });
});

describe("dueCheckpointKinds", () => {
    test("nothing due at 2 sessions", () => {
        expect(dueCheckpointKinds(2).length).toBe(0);
    });

    test("+3s due at exactly 3 sessions", () => {
        expect(dueCheckpointKinds(3)).toEqual(["+3s"]);
    });

    test("+3s and +10s due at 11 sessions", () => {
        expect(dueCheckpointKinds(11)).toEqual(["+3s", "+10s"]);
    });

    test("all three due at 30+ sessions", () => {
        expect(dueCheckpointKinds(30)).toEqual(["+3s", "+10s", "+30s"]);
        expect(dueCheckpointKinds(42)).toEqual(["+3s", "+10s", "+30s"]);
    });
});

describe("checkpointKey", () => {
    test("deterministic and disambiguates by kind", () => {
        expect(checkpointKey("exp_a", "+3s")).toBe(checkpointKey("exp_a", "+3s"));
        expect(checkpointKey("exp_a", "+3s")).not.toBe(checkpointKey("exp_a", "+10s"));
    });

    test("uses a typed content hash ID", () => {
        const key = checkpointKey("exp_a", "+3s");
        expect(key).not.toContain("+");
        expect(key).toMatch(/^[0-9a-f]{32}$/);
    });
});

// ---------------------------------------------------------------------------
// Production-DDL integration
// ---------------------------------------------------------------------------

const INSTALLED_AT = new Date("2026-01-10T00:00:00Z");
const CREATED_AT = new Date("2026-01-01T00:00:00Z");

interface PublishOpts {
    /** Sessions started AFTER the install; each counts toward a window. */
    readonly sessions?: number;
    /** Sessions started after ACCEPTANCE but before the install - never counted. */
    readonly preInstallSessions?: number;
    /** Subagent-source sessions after the install - never counted. */
    readonly subagentSessions?: number;
    readonly opportunities?: number;
    readonly addressed?: number;
    /** The derivation-version sentinel to publish, or null for none. */
    readonly marker?: string | null;
    /** `source_kind` for the sentinel row, to test a foreign marker. */
    readonly markerSource?: string;
    readonly experimentKey?: string;
    /** Base instant for the post-install sessions (default: the install). */
    readonly sessionsFrom?: Date;
    /** `matched_at` for the opportunity rows (default: just after the install). */
    readonly matchedAt?: Date;
    /** `cites_evidence` edges to publish: proposal -> skill_candidate. */
    readonly candidateEdges?: ReadonlyArray<{
        readonly proposal: string;
        readonly candidate: string;
        /** Write the `skill_candidate` row too (false = a dangling edge). */
        readonly resolvable: boolean;
    }>;
}

/** One published snapshot, built through the production cache DDL. */
const publishSnapshot = (root: string, opts: PublishOpts = {}) => {
    const sessions = opts.sessions ?? 0;
    const preInstall = opts.preInstallSessions ?? 0;
    const subagents = opts.subagentSessions ?? 0;
    const opportunities = opts.opportunities ?? 0;
    const addressed = opts.addressed ?? 0;
    const marker = opts.marker === undefined ? OPPORTUNITY_VERSION : opts.marker;
    const experimentKey = opts.experimentKey ?? "experiment-one";
    const sessionsFrom = opts.sessionsFrom ?? INSTALLED_AT;
    const matchedAt = opts.matchedAt ?? new Date(INSTALLED_AT.getTime() + 1000);
    const lockPath = join(root, "ingest.lock");
    return Effect.runPromise(withIngestLock({
        lockPath,
        command: "derive-checkpoints-test",
        staleMs: 60_000,
        onBusy: () => Effect.die("unexpected busy lock"),
    }, withCacheWrite({
        livePath: join(root, "live.duckdb"),
        lockPath,
        snapshotPath: join(root, "snapshot.duckdb"),
        schemaSql: CACHE_DDL,
        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
    }, (write) => Effect.gen(function* () {
        yield* write.exec("DELETE FROM session");
        yield* write.exec("DELETE FROM opportunity");
        yield* write.exec("DELETE FROM cites_evidence");
        yield* write.exec("DELETE FROM skill_candidate");
        yield* write.exec(`DELETE FROM ${WATERMARK_TABLE}`);
        yield* write.putMany("session", [
            // Accepted-but-not-installed exposure: after created_at, before the
            // observed install, so it can say nothing about the artifact.
            ...Array.from({ length: preInstall }, (_, n) => ({
                id: `pre-${n + 1}`, source: "claude",
                started_at: new Date(CREATED_AT.getTime() + n + 1), ended_at: null,
            })),
            ...Array.from({ length: subagents }, (_, n) => ({
                id: `sub-${n + 1}`, source: n % 2 === 0 ? "claude-subagent" : "codex-subagent",
                started_at: new Date(sessionsFrom.getTime() + n + 1), ended_at: null,
            })),
            ...Array.from({ length: sessions }, (_, n) => ({
                id: `session-${n + 1}`, source: "claude",
                started_at: new Date(sessionsFrom.getTime() + n + 1), ended_at: null,
            })),
        ]);
        yield* write.putMany("opportunity", Array.from({ length: opportunities }, (_, n) => ({
            id: `o${n + 1}`,
            in_id: experimentKey,
            out_id: "session-1",
            out_table: "session",
            matched_at: matchedAt,
            was_addressed: n < addressed,
        })));
        for (const edge of opts.candidateEdges ?? []) {
            if (edge.resolvable) {
                yield* write.put("skill_candidate", {
                    id: edge.candidate, name: edge.candidate, trigger_pattern: "schema edits",
                    suspected_gap: "gap", proposed_behavior: "behavior", confidence: "high",
                    expected_impact: null, status: "candidate", labels: null, metrics: null,
                    created_at: CREATED_AT,
                });
            }
            yield* write.put("cites_evidence", {
                id: `cites-${edge.proposal}-${edge.candidate}`,
                in_id: edge.proposal, out_id: edge.candidate,
                in_table: "proposal", out_table: "skill_candidate",
                count: 1, kind: null, ts: CREATED_AT,
            });
        }
        if (marker !== null) {
            yield* write.put(
                WATERMARK_TABLE,
                watermarkRow(opts.markerSource ?? OPPORTUNITY_VERSION_SOURCE, OPPORTUNITY_VERSION_PATH, {
                    sha: marker,
                }),
            );
        }
    }))).pipe(Effect.provide(Platform)));
};

const CheckpointRow = Schema.Struct({
    id: TextColumn,
    experiment: TextColumn,
    kind: TextColumn,
    suggested: Schema.NullOr(TextColumn),
    user_verdict: Schema.NullOr(TextColumn),
    measured: TextColumn,
    observed_at: TimestampColumn,
});

interface ProposalSeed {
    readonly id: string;
    readonly form?: string;
    /** skill_proposal.trigger_pattern for skill-form seeds. */
    readonly skillTrigger?: string;
    readonly status?: string;
    readonly frequency?: number;
    readonly baseline?: string | null;
    readonly experiment?: {
        readonly id: string;
        readonly status?: string;
        readonly locked_verdict?: string | null;
        readonly artifact_path?: string | null;
        readonly scaffolded_at?: Date | null;
    };
}

const stores = (root: string) => Layer.mergeAll(
    CacheReadLayer({
        snapshotPath: join(root, "snapshot.duckdb"),
        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
    }),
    JudgmentLayer({ sidecarPath: join(root, "judgment.sqlite"), schemaSql: SIDECAR_SCHEMA_SQL }),
);

const seed = (root: string, proposals: ReadonlyArray<ProposalSeed>) =>
    Effect.runPromise(Effect.gen(function* () {
        const judgment = yield* Judgment;
        for (const p of proposals) {
            yield* judgment.put("proposal", {
                id: p.id, form: p.form ?? "guidance", title: `T-${p.id}`, hypothesis: "H",
                dedupe_sig: `sig-${p.id}`, frequency: p.frequency ?? 3, confidence: "high",
                status: p.status ?? "accepted", origin: "agent",
                hypothesis_template: null, evidence_query: null, reject_reason: null,
                baseline: p.baseline === undefined ? JSON.stringify({ frequency: 3 }) : p.baseline,
                created_at: CREATED_AT, updated_at: CREATED_AT,
            });
            if (p.form === "guidance" || p.form === undefined) {
                yield* judgment.put("guidance_proposal", {
                    id: `guidance-${p.id}`, proposal: p.id, file_target: "CLAUDE.md",
                    section: null, suggested_text: "do the thing",
                });
            }
            if (p.form === "skill") {
                yield* judgment.put("skill_proposal", {
                    id: `skill-${p.id}`, proposal: p.id,
                    trigger_pattern: p.skillTrigger ?? "the agent edits schema files",
                    suspected_gap: "gap", proposed_behavior: "behavior", expected_impact: null,
                });
            }
            if (p.experiment) {
                yield* judgment.put("experiment", {
                    id: p.experiment.id, proposal: p.id, artifact: null,
                    artifact_path: p.experiment.artifact_path === undefined
                        ? join(root, "CLAUDE.md")
                        : p.experiment.artifact_path,
                    scaffolded_at: p.experiment.scaffolded_at === undefined
                        ? INSTALLED_AT
                        : p.experiment.scaffolded_at,
                    created_at: CREATED_AT,
                    locked_verdict: p.experiment.locked_verdict ?? null,
                    status: p.experiment.status ?? "scaffolded",
                    task_path: null,
                });
            }
        }
    }).pipe(Effect.provide(stores(root)), Effect.scoped));

const run = (
    root: string,
    opts: { readonly now?: Date; readonly force?: boolean; readonly beforeWrite?: Effect.Effect<void> } = {},
) => Effect.runPromise(Effect.gen(function* () {
    const stats = yield* deriveCheckpoints({ now: opts.now ?? new Date("2026-02-01T00:00:00Z"), ...opts });
    const judgment = yield* Judgment;
    const rows = yield* judgment.rows(
        CheckpointRow,
        "SELECT id, experiment, kind, suggested, user_verdict, measured, observed_at FROM checkpoint ORDER BY experiment, kind",
    );
    return { stats, rows: rows.map((row) => ({ ...row, measured: JSON.parse(row.measured) as Record<string, unknown> })) };
}).pipe(Effect.provide(stores(root)), Effect.scoped));

const lockVerdict = (root: string, checkpointId: string, verdict: string) =>
    Effect.runPromise(Effect.gen(function* () {
        const judgment = yield* Judgment;
        yield* judgment.exec("UPDATE checkpoint SET user_verdict = ? WHERE id = ?", [verdict, checkpointId]);
        yield* judgment.exec(
            "UPDATE experiment SET locked_verdict = ? WHERE id = (SELECT experiment FROM checkpoint WHERE id = ?)",
            [verdict, checkpointId],
        );
    }).pipe(Effect.provide(stores(root)), Effect.scoped));

dtest("measures only eligible experiments, windowed on the observed install", async () => {
    const root = tempDir("ax-checkpoint-eligibility-");
    await publishSnapshot(root, {
        sessions: 30, preInstallSessions: 30, subagentSessions: 30,
        opportunities: 12, addressed: 8,
    });
    await seed(root, [
        { id: "p-ok", experiment: { id: "experiment-one" } },
        { id: "p-open", status: "open", experiment: { id: "exp-open" } },
        { id: "p-emitted", experiment: { id: "exp-emitted", status: "task_emitted" } },
        { id: "p-retired", experiment: { id: "exp-retired", status: "retired" } },
        { id: "p-regressed", experiment: { id: "exp-regressed", status: "regressed" } },
        { id: "p-locked", experiment: { id: "exp-locked", locked_verdict: "adopted" } },
        { id: "p-nopath", experiment: { id: "exp-nopath", artifact_path: null } },
        { id: "p-noinstall", experiment: { id: "exp-noinstall", scaffolded_at: null } },
    ]);

    const result = await run(root);
    expect(result.stats.experimentsScanned).toBe(1);
    expect(result.stats.experimentsExcluded).toBe(7);
    expect(result.stats.checkpointsInserted).toBe(3);
    expect(result.rows.map((row) => row.experiment)).toEqual(["experiment-one", "experiment-one", "experiment-one"]);
    for (const row of result.rows) {
        expect(row.suggested).toBe("adopted");
        expect(row.measured).toEqual({
            opportunities: 12, addressed: 8, ratio: 8 / 12, built: true,
            current_frequency: 3, baseline_frequency: 3,
            measurement_status: "measured", measurement_version: 2,
        });
    }
}, 120_000); // Production DDL snapshot + sidecar seeding share this budget.

dtest("pre-install and subagent sessions never satisfy a window", async () => {
    const root = tempDir("ax-checkpoint-denominator-");
    // 2 real post-install sessions is below +3s; the 40 pre-install + 40
    // subagent sessions must not push it over the line.
    await publishSnapshot(root, {
        sessions: 2, preInstallSessions: 40, subagentSessions: 40, opportunities: 5, addressed: 4,
    });
    await seed(root, [{ id: "p-ok", experiment: { id: "experiment-one" } }]);

    expect((await run(root)).rows).toEqual([]);

    await publishSnapshot(root, {
        sessions: 3, preInstallSessions: 40, subagentSessions: 40, opportunities: 5, addressed: 4,
    });
    const due = await run(root);
    expect(due.rows.map((row) => row.kind)).toEqual(["+3s"]);
    expect(due.stats.checkpointsInserted).toBe(1);
}, 120_000); // Two production snapshots.

dtest("reports a needed derivation even when no window is due", async () => {
    const root = tempDir("ax-checkpoint-marker-idle-");
    // Nothing is due (0 sessions), but the snapshot still carries no corrected
    // derivation certificate - and the user has to hear that before the first
    // window arrives, not after it lands as insufficient data.
    await publishSnapshot(root, { sessions: 0, opportunities: 12, addressed: 8, marker: null });
    await seed(root, [{ id: "p-ok", experiment: { id: "experiment-one" } }]);

    const result = await run(root);
    expect(result.stats.cacheRefreshRequired).toBe(1);
    expect(result.stats.checkpointsInserted).toBe(0);
    expect(result.rows).toEqual([]);
}, 120_000); // One production snapshot.

dtest("a failed cache read propagates instead of writing refresh-required rows", async () => {
    const root = tempDir("ax-checkpoint-readfail-");
    await publishSnapshot(root, { sessions: 30, opportunities: 12, addressed: 8 });
    await seed(root, [{ id: "p-ok", experiment: { id: "experiment-one" } }]);

    // A reader pointed at a snapshot that is not there. Under the strict-read
    // contract that is an ERROR - never "the marker is missing", which would
    // stamp every due window insufficient on the strength of a failed open.
    const failure = await Effect.runPromise(
        deriveCheckpoints({ now: new Date("2026-02-01T00:00:00Z") }).pipe(
            Effect.map(() => "unexpected success"),
            Effect.catchCause((cause) => Effect.succeed(cause.toString())),
            Effect.provide(Layer.mergeAll(
                CacheReadLayer({
                    snapshotPath: join(root, "absent.duckdb"),
                    ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                }),
                JudgmentLayer({ sidecarPath: join(root, "judgment.sqlite"), schemaSql: SIDECAR_SCHEMA_SQL }),
            )),
            Effect.scoped,
        ),
    );
    expect(failure).not.toBe("unexpected success");
    const stored = await Effect.runPromise(Effect.gen(function* () {
        const judgment = yield* Judgment;
        return yield* judgment.rows(CheckpointRow, "SELECT id, experiment, kind, suggested, user_verdict, measured, observed_at FROM checkpoint");
    }).pipe(Effect.provide(stores(root)), Effect.scoped));
    expect(stored).toEqual([]);
    // The same sidecar measures normally once a reachable snapshot is used.
    expect((await run(root)).rows.length).toBe(3);
}, 120_000); // One production snapshot plus a deliberate read failure.

dtest("zero opportunities and unsupported detectors are insufficient data, not verdicts", async () => {
    const root = tempDir("ax-checkpoint-insufficient-");
    await publishSnapshot(root, { sessions: 3, opportunities: 0 });
    await seed(root, [
        // Zero opportunities, with a baseline that used to decide the verdict.
        { id: "p-zero", frequency: 9, experiment: { id: "experiment-one" } },
        { id: "p-zero-equal", frequency: 3, experiment: { id: "exp-equal" } },
        { id: "p-zero-nobaseline", baseline: null, experiment: { id: "exp-nobaseline" } },
        { id: "p-zero-badbaseline", baseline: "not json", experiment: { id: "exp-badbaseline" } },
        // No detector exists for the automation form.
        { id: "p-automation", form: "automation", experiment: { id: "exp-automation" } },
    ]);

    const result = await run(root);
    expect(result.stats.experimentsScanned).toBe(5);
    expect(result.stats.checkpointsInserted).toBe(5);
    expect(result.stats.insufficientData).toBe(5);
    const byExperiment = new Map(result.rows.map((row) => [row.experiment, row]));
    for (const id of ["experiment-one", "exp-equal", "exp-nobaseline", "exp-badbaseline"]) {
        const row = byExperiment.get(id)!;
        expect(row.suggested).toBeNull();
        expect(row.measured.measurement_status).toBe("insufficient_data");
        expect(row.measured.reason).toBe("no_opportunities");
        expect(row.measured.opportunities).toBe(0);
        expect(row.measured.measurement_version).toBe(2);
    }
    const automation = byExperiment.get("exp-automation")!;
    expect(automation.suggested).toBeNull();
    expect(automation.measured.reason).toBe("detector_unavailable");
}, 120_000); // Five experiments over one production snapshot.

dtest("opportunity rows cached before the recorded installation never count", async () => {
    const root = tempDir("ax-checkpoint-reinstall-");
    const reinstalledAt = new Date(INSTALLED_AT.getTime() + 3_600_000);
    // The snapshot is valid by every other measure: corrected marker, positive
    // addressed rows. They were matched against the PREVIOUS installation, and
    // the sidecar recorded the new one before this command started - so the
    // write-transaction guard, which only sees changes DURING the command,
    // cannot catch it.
    await publishSnapshot(root, {
        sessions: 30,
        sessionsFrom: reinstalledAt,
        opportunities: 12,
        addressed: 12,
        matchedAt: new Date(INSTALLED_AT.getTime() + 1000),
    });
    await seed(root, [{
        id: "p-ok",
        experiment: { id: "experiment-one", scaffolded_at: reinstalledAt },
    }]);

    const result = await run(root);
    expect(result.stats.insufficientData).toBe(3);
    for (const row of result.rows) {
        expect(row.suggested).toBeNull();
        expect(row.measured.opportunities).toBe(0);
        expect(row.measured.addressed).toBe(0);
        expect(row.measured.reason).toBe("no_opportunities");
    }

    // Evidence matched against the CURRENT installation measures normally.
    await publishSnapshot(root, {
        sessions: 30,
        sessionsFrom: reinstalledAt,
        opportunities: 12,
        addressed: 12,
        matchedAt: new Date(reinstalledAt.getTime() + 1000),
    });
    const measured = await run(root, { now: new Date("2026-02-09T00:00:00Z") });
    expect(measured.stats.checkpointsRefreshed).toBe(3);
    for (const row of measured.rows) {
        expect(row.suggested).toBe("adopted");
        expect(row.measured.opportunities).toBe(12);
    }
}, 180_000); // Two production snapshots plus a recorded reinstallation.

dtest("a skill candidate must resolve to a row, not just a cites_evidence edge", async () => {
    const root = tempDir("ax-checkpoint-candidate-");
    await publishSnapshot(root, {
        sessions: 3, opportunities: 12, addressed: 8,
        candidateEdges: [
            { proposal: "p-dangling", candidate: "candidate-gone", resolvable: false },
            { proposal: "p-prose", candidate: "candidate-gone-2", resolvable: false },
            { proposal: "p-resolved", candidate: "candidate-live", resolvable: true },
        ],
    });
    await seed(root, [
        // A dangling edge with a prose trigger: nothing can detect this skill.
        { id: "p-dangling", form: "skill", experiment: { id: "experiment-one" } },
        // A dangling edge, but the supported tool trigger still detects it.
        { id: "p-prose", form: "skill", skillTrigger: "tool=Bash", experiment: { id: "exp-prose" } },
        // The cited candidate is really there.
        { id: "p-resolved", form: "skill", experiment: { id: "exp-resolved" } },
    ]);

    const rows = new Map((await run(root)).rows.map((row) => [row.experiment, row]));
    expect(rows.get("experiment-one")!.suggested).toBeNull();
    expect(rows.get("experiment-one")!.measured.reason).toBe("detector_unavailable");
    // Both of these HAVE a detector, so their windows report the measurement
    // gap (no opportunity rows were seeded for them) rather than the absence of
    // any way to detect the artifact.
    expect(rows.get("exp-prose")!.measured.reason).toBe("no_opportunities");
    expect(rows.get("exp-resolved")!.measured.reason).toBe("no_opportunities");
}, 120_000); // One production snapshot with three skill-form experiments.

dtest("a refresh updates the stored row, whatever id it carries", async () => {
    const root = tempDir("ax-checkpoint-noncanonical-");
    await publishSnapshot(root, { sessions: 10, opportunities: 12, addressed: 8 });
    await seed(root, [
        { id: "p-refresh", experiment: { id: "experiment-one" } },
        { id: "p-reviewed", experiment: { id: "exp-reviewed" } },
    ]);
    // Rows keyed by something other than `checkpointKey` - older history, or a
    // producer that keyed them differently. Both are the canonical row for
    // their window as far as the reader is concerned.
    await Effect.runPromise(Effect.gen(function* () {
        const judgment = yield* Judgment;
        yield* judgment.put("checkpoint", {
            id: "legacy-noncanonical-refresh", experiment: "experiment-one", kind: "+3s",
            measured: JSON.stringify({ opportunities: 40, addressed: 39, ratio: 0.975, built: true }),
            suggested: "adopted", user_verdict: null, observed_at: new Date("2026-01-20T00:00:00Z"),
        });
        yield* judgment.put("checkpoint", {
            id: "legacy-noncanonical-reviewed", experiment: "exp-reviewed", kind: "+3s",
            measured: JSON.stringify({ opportunities: 40, addressed: 39, ratio: 0.975, built: true }),
            suggested: "adopted", user_verdict: "partial", observed_at: new Date("2026-01-20T00:00:00Z"),
        });
    }).pipe(Effect.provide(stores(root)), Effect.scoped));

    const result = await run(root);
    const refreshed = result.rows.filter((row) => row.experiment === "experiment-one" && row.kind === "+3s");
    expect(refreshed.map((row) => row.id)).toEqual(["legacy-noncanonical-refresh"]);
    expect(refreshed[0]!.measured.opportunities).toBe(12);
    expect(refreshed[0]!.measured.measurement_version).toBe(2);
    // No second row for the same window under the canonical id.
    expect(result.rows.some((row) => row.id === checkpointKey("experiment-one", "+3s"))).toBe(false);

    // The reviewed noncanonical row keeps the human's answer, unduplicated.
    const reviewed = result.rows.filter((row) => row.experiment === "exp-reviewed" && row.kind === "+3s");
    expect(reviewed.map((row) => row.id)).toEqual(["legacy-noncanonical-reviewed"]);
    expect(reviewed[0]!.user_verdict).toBe("partial");
    expect(reviewed[0]!.suggested).toBe("adopted");
    expect(reviewed[0]!.observed_at).toEqual(new Date("2026-01-20T00:00:00Z"));
}, 120_000); // One production snapshot plus two seeded noncanonical rows.

dtest("a missing or foreign derivation marker forces refresh instead of measuring old rows", async () => {
    const root = tempDir("ax-checkpoint-marker-");
    const invalidMarkers: ReadonlyArray<PublishOpts> = [
        { marker: null },
        { marker: "" },
        { marker: "artifact-identity-v2" },
        { marker: "who-knows" },
        { marker: OPPORTUNITY_VERSION, markerSource: "some_other_stage" },
    ];
    await publishSnapshot(root, { sessions: 3, opportunities: 12, addressed: 8, ...invalidMarkers[0] });
    await seed(root, [{ id: "p-ok", experiment: { id: "experiment-one" } }]);

    for (const marker of invalidMarkers) {
        await publishSnapshot(root, { sessions: 3, opportunities: 12, addressed: 8, ...marker });
        const result = await run(root);
        expect(result.stats.cacheRefreshRequired).toBe(1);
        expect(result.rows.length).toBe(1);
        const row = result.rows[0]!;
        expect(row.suggested).toBeNull();
        expect(row.measured.measurement_status).toBe("insufficient_data");
        expect(row.measured.reason).toBe("refresh_required");
    }

    // The corrected derivation lands: the same ordinary (unforced) run now
    // measures the window that had been left null.
    await publishSnapshot(root, { sessions: 3, opportunities: 12, addressed: 8 });
    const measured = await run(root, { now: new Date("2026-02-02T00:00:00Z") });
    expect(measured.stats.cacheRefreshRequired).toBe(0);
    expect(measured.stats.checkpointsRefreshed).toBe(1);
    expect(measured.rows[0]!.suggested).toBe("adopted");
    expect(measured.rows[0]!.measured.measurement_status).toBe("measured");

    // A measured window is stable across ordinary reruns...
    const rerun = await run(root, { now: new Date("2026-02-03T00:00:00Z") });
    expect(rerun.stats.checkpointsRefreshed).toBe(0);
    expect(rerun.rows).toEqual(measured.rows);

    // ...but an invalid marker must not leave an old positive answer standing.
    await publishSnapshot(root, { sessions: 3, opportunities: 12, addressed: 8, marker: null });
    const invalidated = await run(root, { now: new Date("2026-02-04T00:00:00Z") });
    expect(invalidated.stats.checkpointsRefreshed).toBe(1);
    expect(invalidated.rows[0]!.suggested).toBeNull();
    expect(invalidated.rows[0]!.measured.reason).toBe("refresh_required");
}, 180_000); // Eight production snapshots, one per marker case.

dtest("refresh preserves reviewed rows, locked experiments and unchanged measured windows", async () => {
    const root = tempDir("ax-checkpoint-refresh-");
    await publishSnapshot(root, { sessions: 30, opportunities: 12, addressed: 8 });
    await seed(root, [{ id: "p-ok", experiment: { id: "experiment-one" } }]);
    const first = await run(root);
    expect(first.stats.checkpointsInserted).toBe(3);

    // A human reviews the +3s window. Nothing may touch it again - not an
    // ordinary run, not --force.
    const reviewed = first.rows.find((row) => row.kind === "+3s")!;
    await Effect.runPromise(Effect.gen(function* () {
        const judgment = yield* Judgment;
        yield* judgment.exec("UPDATE checkpoint SET user_verdict = ? WHERE id = ?", ["partial", reviewed.id]);
    }).pipe(Effect.provide(stores(root)), Effect.scoped));

    await publishSnapshot(root, { sessions: 30, opportunities: 12, addressed: 0 });
    const ordinary = await run(root, { now: new Date("2026-02-05T00:00:00Z") });
    expect(ordinary.stats.checkpointsRefreshed).toBe(0);
    expect(ordinary.rows.find((row) => row.kind === "+3s")).toEqual({
        ...reviewed, user_verdict: "partial",
    });

    const forced = await run(root, { now: new Date("2026-02-06T00:00:00Z"), force: true });
    expect(forced.stats.checkpointsRefreshed).toBe(2);
    expect(forced.rows.find((row) => row.kind === "+3s")).toEqual({
        ...reviewed, user_verdict: "partial",
    });
    for (const kind of ["+10s", "+30s"]) {
        const row = forced.rows.find((r) => r.kind === kind)!;
        expect(row.suggested).toBe("ignored");
        expect(row.observed_at).toEqual(new Date("2026-02-06T00:00:00Z"));
    }

    // Locking the experiment freezes every remaining row, even under --force.
    await lockVerdict(root, forced.rows.find((row) => row.kind === "+10s")!.id, "ignored");
    const afterLock = await run(root, { now: new Date("2026-02-07T00:00:00Z"), force: true });
    expect(afterLock.stats.experimentsScanned).toBe(0);
    expect(afterLock.stats.experimentsExcluded).toBe(1);
    expect(afterLock.rows.map((row) => row.measured)).toEqual(
        forced.rows.map((row) => row.measured),
    );
}, 180_000); // Four production snapshots plus repeated refresh passes.

dtest("an old unreviewed row without the current measurement version is refreshed", async () => {
    const root = tempDir("ax-checkpoint-legacy-");
    await publishSnapshot(root, { sessions: 3, opportunities: 12, addressed: 8 });
    await seed(root, [{ id: "p-ok", experiment: { id: "experiment-one" } }]);
    const legacyId = checkpointKey("experiment-one", "+3s");
    await Effect.runPromise(Effect.gen(function* () {
        const judgment = yield* Judgment;
        yield* judgment.put("checkpoint", {
            id: legacyId, experiment: "experiment-one", kind: "+3s",
            // A pre-#1134 positive row: no measurement_version, and its
            // opportunities came from the uncorrected derivation.
            measured: JSON.stringify({ opportunities: 40, addressed: 39, ratio: 0.975, built: true }),
            suggested: "adopted", user_verdict: null, observed_at: new Date("2026-01-20T00:00:00Z"),
        });
    }).pipe(Effect.provide(stores(root)), Effect.scoped));

    const result = await run(root);
    expect(result.stats.checkpointsRefreshed).toBe(1);
    expect(result.stats.checkpointsInserted).toBe(0);
    const row = result.rows[0]!;
    expect(row.id).toBe(legacyId);
    expect(row.measured.opportunities).toBe(12);
    expect(row.measured.measurement_version).toBe(2);
}, 120_000); // One production snapshot plus a seeded legacy row.

dtest("a verdict or lifecycle change during the cache read cancels that write", async () => {
    const root = tempDir("ax-checkpoint-race-");
    await publishSnapshot(root, { sessions: 30, opportunities: 12, addressed: 8 });
    await seed(root, [
        { id: "p-race", experiment: { id: "experiment-one" } },
        { id: "p-retire", experiment: { id: "exp-two" } },
    ]);
    const first = await run(root);
    expect(first.stats.checkpointsInserted).toBe(6);

    await publishSnapshot(root, { sessions: 30, opportunities: 12, addressed: 0 });
    const raced = await run(root, {
        now: new Date("2026-02-08T00:00:00Z"),
        force: true,
        // Between the cache read and the sidecar write: a human locks one
        // experiment, and the other retires. Neither may be overwritten.
        beforeWrite: Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* judgment.exec("UPDATE checkpoint SET user_verdict = ? WHERE experiment = ?", ["adopted", "experiment-one"]);
            yield* judgment.exec("UPDATE experiment SET locked_verdict = ? WHERE id = ?", ["adopted", "experiment-one"]);
            yield* judgment.exec("UPDATE experiment SET status = ? WHERE id = ?", ["retired", "exp-two"]);
        }).pipe(Effect.provide(stores(root)), Effect.scoped, Effect.orDie),
    });
    expect(raced.stats.checkpointsRefreshed).toBe(0);
    // Byte-for-byte: the locked row keeps its answer and the retired
    // experiment's history keeps its timestamps.
    expect(raced.rows).toEqual(first.rows.map((row) => ({
        ...row,
        ...(row.experiment === "experiment-one" ? { user_verdict: "adopted" } : {}),
    })));
}, 180_000); // Two production snapshots plus a concurrent-write simulation.

dtest("a changed installation timestamp cancels the stale write", async () => {
    const root = tempDir("ax-checkpoint-install-");
    await publishSnapshot(root, { sessions: 30, opportunities: 12, addressed: 8 });
    await seed(root, [{ id: "p-ok", experiment: { id: "experiment-one" } }]);

    const result = await run(root, {
        beforeWrite: Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* judgment.exec("UPDATE experiment SET scaffolded_at = ? WHERE id = ?", [
                new Date("2026-01-25T00:00:00Z").toISOString(), "experiment-one",
            ]);
        }).pipe(Effect.provide(stores(root)), Effect.scoped, Effect.orDie),
    });
    expect(result.stats.checkpointsInserted).toBe(0);
    expect(result.rows).toEqual([]);
}, 120_000); // One production snapshot plus a concurrent reinstall.
