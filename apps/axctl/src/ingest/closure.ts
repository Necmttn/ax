import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { watermarkRow } from "@ax/lib/duckdb/watermark";
import { stableId } from "@ax/lib/stable-id";
import { isoTimestamp, recordKeyPart, safeKeyPart, type TimestampInput } from "@ax/lib/shared/derive-keys";
import { stableDigest } from "@ax/lib/ids";

export type CommitKind = "feature" | "fix" | "refactor" | "test" | "docs" | "chore" | "unknown";

interface CommitRow {
    readonly id: unknown;
    readonly message?: string | null;
    readonly repository?: unknown;
    readonly ts?: TimestampInput;
}

interface TouchedRow {
    readonly in?: unknown;
    readonly out?: unknown;
    readonly path?: string;
}

interface SessionHealthRow {
    readonly session?: unknown;
    readonly tool_errors?: number;
    readonly user_corrections?: number;
    readonly interruptions?: number;
    readonly context_pressure?: string;
}

const keyPart = (value: unknown, table: string): string | null =>
    recordKeyPart(value, table) ?? (typeof value === "string" && value.length > 0 ? value : null);

export interface CommitClassification {
    readonly commitKey: string;
    readonly repositoryKey: string | null;
    readonly kind: CommitKind;
    readonly confidence: "low" | "medium" | "high";
    readonly message: string | null;
    readonly ts: string;
}

export interface FixChain {
    readonly featureKey: string;
    readonly fixKey: string;
    readonly repositoryKey: string | null;
    readonly overlapFiles: readonly string[];
    readonly daysBetween: number;
    readonly confidence: "low" | "medium" | "high";
    readonly reason: string;
    readonly ts: string;
}

export interface SkillCandidate {
    readonly key: string;
    readonly name: string;
    readonly triggerPattern: string;
    readonly suspectedGap: string;
    readonly proposedBehavior: string;
    readonly confidence: "low" | "medium" | "high";
    readonly expectedImpact: string;
    readonly evidenceCommits: readonly string[];
    readonly metrics: Record<string, unknown>;
}

export interface ClosureStats {
    readonly commitClassifications: number;
    readonly fixChains: number;
    readonly skillCandidates: number;
}


export function classifyCommitMessage(message: string | null | undefined): CommitClassification["kind"] {
    const text = (message ?? "").toLowerCase();
    if (/^revert\b/.test(text)) return "chore";
    if (/^(fix|bugfix)(\(.+\))?:| bug| repair| correct| regression/.test(text)) return "fix";
    if (/^refactor(\(.+\))?:| cleanup| simplify/.test(text)) return "refactor";
    if (/^(test|spec)(\(.+\))?:| coverage/.test(text)) return "test";
    if (/^docs?(\(.+\))?:/.test(text)) return "docs";
    if (/^(chore|deps|release)(\(.+\))?:/.test(text)) return "chore";
    if (/^(feat|feature)(\(.+\))?:|\b(add|implement|support)\b/.test(text)) return "feature";
    return "unknown";
}

function candidateForPath(path: string): Omit<SkillCandidate, "key" | "evidenceCommits" | "metrics" | "confidence"> {
    if (path.includes("schema/") || path.endsWith(".surql")) {
        return {
            name: "SurrealDB schema change guardrail",
            triggerPattern: "fix commits overlap SurrealDB schema files",
            suspectedGap: "Schema changes need a tighter migration/apply/query verification loop.",
            proposedBehavior: "Before schema edits, run schema import plus one read/write smoke query for every new table or relation.",
            expectedImpact: "Fewer post-feature fixes after schema changes.",
        };
    }
    if (path.includes("src/ingest/")) {
        return {
            name: "Ingest pipeline regression checklist",
            triggerPattern: "fix commits overlap ingest pipeline files",
            suspectedGap: "Ingest changes need idempotency, duplicate-edge, and repeated-run checks.",
            proposedBehavior: "For ingest edits, run targeted tests plus two back-to-back ingest passes and inspect graph counts.",
            expectedImpact: "Fewer duplicate edges and repeated-ingest regressions.",
        };
    }
    if (path.includes("src/queries/")) {
        return {
            name: "Graph query dogfood checklist",
            triggerPattern: "fix commits overlap graph query files",
            suspectedGap: "Query builders can pass string tests while returning slow or low-signal output.",
            proposedBehavior: "After query edits, run the live insight view and tune ranking against real rows before commit.",
            expectedImpact: "More useful insight output and fewer slow cache reads.",
        };
    }
    return {
        name: "Post-feature verification checklist",
        triggerPattern: "feature commits followed by overlapping fixes",
        suspectedGap: "Feature closure needs stronger same-file follow-up verification.",
        proposedBehavior: "Before closure, inspect touched files, run targeted verification, and query recent fix-chain history for the module.",
        expectedImpact: "Lower post-feature fix rate.",
    };
}

export function deriveClosureRows(input: {
    readonly commits: readonly CommitRow[];
    readonly touched: readonly TouchedRow[];
    readonly sessionHealth: readonly SessionHealthRow[];
}): {
    readonly classifications: CommitClassification[];
    readonly fixChains: FixChain[];
    readonly skillCandidates: SkillCandidate[];
} {
    const classifications = input.commits.flatMap((commit) => {
        const commitKey = keyPart(commit.id, "commit");
        if (!commitKey) return [];
        const kind = classifyCommitMessage(commit.message);
        return [{
            commitKey,
            repositoryKey: keyPart(commit.repository, "repository"),
            kind,
            confidence: kind === "unknown" ? "low" : "high",
            message: commit.message ?? null,
            ts: isoTimestamp(commit.ts),
        } satisfies CommitClassification];
    });
    const filesByCommit = new Map<string, Set<string>>();
    for (const touched of input.touched) {
        const commitKey = keyPart(touched.in, "commit");
        if (!commitKey || !touched.path) continue;
        const files = filesByCommit.get(commitKey) ?? new Set<string>();
        files.add(touched.path);
        filesByCommit.set(commitKey, files);
    }

    const features = classifications.filter((item) => item.kind === "feature");
    const fixes = classifications.filter((item) => item.kind === "fix");
    const fixChains: FixChain[] = [];
    for (const feature of features) {
        const featureTime = new Date(feature.ts).getTime();
        const featureFiles = filesByCommit.get(feature.commitKey) ?? new Set<string>();
        if (featureFiles.size === 0) continue;
        for (const fix of fixes) {
            if (feature.repositoryKey && fix.repositoryKey && feature.repositoryKey !== fix.repositoryKey) continue;
            const daysBetween = (new Date(fix.ts).getTime() - featureTime) / 86_400_000;
            if (daysBetween <= 0 || daysBetween > 14) continue;
            const fixFiles = filesByCommit.get(fix.commitKey) ?? new Set<string>();
            const overlap = [...featureFiles].filter((path) => fixFiles.has(path));
            if (overlap.length === 0) continue;
            fixChains.push({
                featureKey: feature.commitKey,
                fixKey: fix.commitKey,
                repositoryKey: feature.repositoryKey ?? fix.repositoryKey,
                overlapFiles: overlap.sort(),
                daysBetween,
                confidence: overlap.length >= 2 ? "high" : "medium",
                reason: `${overlap.length} overlapping file(s) changed by a fix ${daysBetween.toFixed(1)} day(s) after feature commit`,
                ts: fix.ts,
            });
        }
    }

    const candidatesByName = new Map<string, SkillCandidate>();
    for (const chain of fixChains) {
        const firstPath = chain.overlapFiles[0] ?? "";
        const base = candidateForPath(firstPath);
        const existing = candidatesByName.get(base.name);
        const evidence = existing ? [...existing.evidenceCommits, chain.fixKey] : [chain.fixKey];
        candidatesByName.set(base.name, {
            ...base,
            key: safeKeyPart(base.name),
            confidence: evidence.length >= 3 ? "high" : evidence.length >= 2 ? "medium" : "low",
            evidenceCommits: [...new Set(evidence)].slice(0, 25),
            metrics: {
                fix_chain_count: evidence.length,
                latest_fix_commit: chain.fixKey,
            },
        });
    }
    // NOTE: the prior "Session closure quality guardrail" synthetic was
    // dropped because risky_session_count = "any session with ≥5 errors OR
    // any correction OR high pressure" matches every active dev. Per
    // adversarial review of the live retro it surfaced freq=1072 as the
    // top proposal - pure noise. If a closure-quality skill is real,
    // it must derive from a SHARP recurring pattern (Path A continuation,
    // see plan doc) rather than a broad session-count.

    return { classifications, fixChains, skillCandidates: [...candidatesByName.values()] };
}

const closureRows = (rows: ReturnType<typeof deriveClosureRows>) => ({
    classifications: rows.classifications.map((row) => cacheRow({
        id: stableId("commit_classification", [row.commitKey]), commit: row.commitKey,
        repository: row.repositoryKey, kind: row.kind, confidence: row.confidence,
        message: row.message, labels: jsonParam({ source: "closure" }), metrics: jsonParam({}), ts: tsParam(row.ts),
    })),
    fixChains: rows.fixChains.map((row) => cacheRow({
        id: stableId("later_fixed_by", [row.featureKey, row.fixKey]), in_id: row.featureKey,
        out_id: row.fixKey, repository: row.repositoryKey, overlap_files: jsonParam(row.overlapFiles),
        overlap_count: row.overlapFiles.length, days_between: Number(row.daysBetween.toFixed(3)),
        confidence: row.confidence, reason: row.reason, ts: tsParam(row.ts),
    })),
    candidates: rows.skillCandidates.map((row) => cacheRow({
        id: stableId("skill_candidate", [row.name]), name: row.name, trigger_pattern: row.triggerPattern,
        suspected_gap: row.suspectedGap, proposed_behavior: row.proposedBehavior, confidence: row.confidence,
        expected_impact: row.expectedImpact, status: "candidate", labels: jsonParam({ source: "closure" }),
        metrics: jsonParam(row.metrics), created_at: new Date(),
    })),
    suggestions: rows.skillCandidates.flatMap((row) => row.evidenceCommits.map((commitKey) => cacheRow({
        id: stableId("suggests_skill", [commitKey, row.name]), in_id: commitKey,
        out_id: stableId("skill_candidate", [row.name]), reason: row.triggerPattern,
        evidence: jsonParam(row.metrics), confidence: row.confidence, ts: new Date(),
    }))),
});

// ---------- skip-unchanged watermark (hypothesis 008) ----------
//
// The closure stage blanket-DELETEs and fully re-derives its output
// (commit_classification + later_fixed_by + suggests_skill + skill_candidate)
// on every run - the dominant warm cost (the later_fixed_by DELETE + RELATE of
// thousands of edges). But the closure output is a deterministic function of
// its inputs (commit + touched + session_health) and `sinceDays`. On the warm
// path those inputs are unchanged (git skip-unchanged means no new commits), so
// the re-derive reproduces identical rows. We cache a single fingerprint of the
// loaded inputs in the shared `ingest_file_state` table (source_kind='closure',
// fixed sentinel path). On the next run, if the fingerprint matches the stored
// digest the output already persists ⇒ skip the blanket DELETE + write entirely
// (output-equivalent). Any input change (or a wider sinceDays) yields a new
// digest, forcing a full re-derive. The reads still run (they are the cheap
// part); only the costly DELETE + RELATE writes are skipped. NEVER `NOT IN`:
// the watermark is one indexed read. `AX_REDERIVE_CLOSURE=1` forces a full
// re-derive (ignores the watermark).

const CLOSURE_WATERMARK_SOURCE = "closure";
const CLOSURE_WATERMARK_PATH = "__closure__";

const closureInputFingerprint = (input: {
    readonly commits: readonly CommitRow[];
    readonly touched: readonly TouchedRow[];
    readonly sessionHealth: readonly SessionHealthRow[];
    readonly sinceDays: number | undefined;
}): string => {
    const parts: string[] = [`since=${input.sinceDays ?? ""}`];
    parts.push(`commits=${input.commits.length}`);
    for (const c of input.commits) {
        parts.push(`c|${keyPart(c.id, "commit") ?? ""}|${isoTimestamp(c.ts)}|${c.message ?? ""}|${keyPart(c.repository, "repository") ?? ""}`);
    }
    parts.push(`touched=${input.touched.length}`);
    for (const t of input.touched) {
        parts.push(`t|${keyPart(t.in, "commit") ?? ""}|${t.path ?? ""}`);
    }
    parts.push(`health=${input.sessionHealth.length}`);
    for (const h of input.sessionHealth) {
        parts.push(`h|${keyPart(h.session, "session") ?? ""}|${h.tool_errors ?? ""}|${h.user_corrections ?? ""}|${h.interruptions ?? ""}|${h.context_pressure ?? ""}`);
    }
    // 32-hex digest keeps collisions astronomically unlikely for this corpus.
    return stableDigest(parts.join("\n"), 32);
};

const loadClosureWatermark = (
    write: CacheWriteService,
): Effect.Effect<string | undefined, CacheReadError> =>
    Effect.gen(function* () {
        const rows = yield* write.rows(
            Schema.Struct({ sha: Schema.NullOr(Schema.String) }),
            "SELECT sha FROM ingest_file_state WHERE source_kind = ? AND path = ?",
            [CLOSURE_WATERMARK_SOURCE, CLOSURE_WATERMARK_PATH],
        );
        const sha = rows[0]?.sha;
        return typeof sha === "string" ? sha : undefined;
    });

const upsertClosureWatermark = (
    write: CacheWriteService,
    digest: string,
): Effect.Effect<void, CacheWriteError> =>
    write.put("ingest_file_state", watermarkRow(CLOSURE_WATERMARK_SOURCE, CLOSURE_WATERMARK_PATH, { sha: digest }));

export const deriveClosure = (
    write: CacheWriteService,
    opts: { sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<ClosureStats, CacheReadError | CacheWriteError> =>
    Effect.gen(function* () {
        const forceRederive = process.env.AX_REDERIVE_CLOSURE === "1";
        const [commits, touched, sessionHealth, storedDigest] = yield* Effect.all([
            write.rows(Schema.Struct({ id: Schema.String, message: Schema.NullOr(Schema.String), repository: Schema.NullOr(Schema.String), ts: TimestampColumn }), `
SELECT id, message, repository, ts
FROM commit
${opts.sinceDays === undefined ? "" : "WHERE ts >= current_timestamp - (? * INTERVAL '1 day')"}
ORDER BY ts ASC`, opts.sinceDays === undefined ? [] : [opts.sinceDays]),
            write.rows(Schema.Struct({ in: Schema.String, out: Schema.String, path: Schema.String }), `
SELECT t.in_id AS in, t.out_id AS out, f.path
FROM touched t JOIN file f ON f.id = t.out_id`),
            write.rows(Schema.Struct({
                session: Schema.String, tool_errors: NumberFromBigIntColumn,
                user_corrections: NumberFromBigIntColumn, interruptions: NumberFromBigIntColumn,
                context_pressure: Schema.String,
            }), `
SELECT session, tool_errors, user_corrections, interruptions, context_pressure
FROM session_health`),
            forceRederive
                ? (Effect.undefined as Effect.Effect<string | undefined>)
                : loadClosureWatermark(write),
        ], { concurrency: 4 }).pipe(Effect.withSpan("closure.fetch"));
        const rows = deriveClosureRows({ commits, touched, sessionHealth });
        const stats: ClosureStats = {
            commitClassifications: rows.classifications.length,
            fixChains: rows.fixChains.length,
            skillCandidates: rows.skillCandidates.length,
        };
        const digest = closureInputFingerprint({ commits, touched, sessionHealth, sinceDays: opts.sinceDays });
        if (!forceRederive && storedDigest === digest) {
            // Inputs unchanged ⇒ persisted output is identical ⇒ skip the
            // blanket DELETE + full re-write entirely (output-equivalent).
            return stats;
        }
        for (const table of ["later_fixed_by", "suggests_skill", "skill_candidate", "commit_classification"]) {
            yield* write.exec(`DELETE FROM ${table}`);
        }
        const persisted = closureRows(rows);
        yield* write.putMany("commit_classification", persisted.classifications);
        yield* write.putMany("later_fixed_by", persisted.fixChains);
        yield* write.putMany("skill_candidate", persisted.candidates);
        yield* write.putMany("suggests_skill", persisted.suggestions);
        yield* upsertClosureWatermark(write, digest);
        return stats;
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const ClosureKey = Schema.Literal("closure");
export type ClosureKey = typeof ClosureKey.Type;

/**
 * Closure stage - derives Change Set + File Memory rows from commit + session join.
 * Depends on {@link SignalsKey}. Consumed by {@link ProposalsKey}.
 */
// Named ClosureStageStats to avoid collision with the original ClosureStats interface.
export class ClosureStageStats extends BaseStageStats.extend<ClosureStageStats>("ClosureStageStats")({
    commitClassifications: Schema.Number,
    skillCandidates: Schema.Number,
}) {}

export const closureStage: StageDef<ClosureStageStats, never, import("./stage/registry.ts").IngestStageError> = {
    meta: StageMeta.make({ key: "closure", deps: ["signals"], tags: ["derive"] }),
    run: (ctx: IngestContext, write) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* deriveClosure(write, { sinceDays });
            return ClosureStageStats.make({
                durationMs: Date.now() - t0,
                summary: `classified ${result.commitClassifications} commits, ${result.skillCandidates} skill candidates`,
                commitClassifications: result.commitClassifications,
                skillCandidates: result.skillCandidates,
            });
        }),
};
