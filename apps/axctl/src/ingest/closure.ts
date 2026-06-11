import { Effect, Schema } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import type { DbError } from "@ax/lib/errors";
import { recordRef } from "./evidence-writers.ts";
import { surrealDate, surrealJsonOption, surrealObject, surrealOptionString, surrealString } from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { isoTimestamp, recordKeyPart, safeKeyPart, type TimestampInput } from "@ax/lib/shared/derive-keys";
import { recordLiteral, stableDigest } from "@ax/lib/ids";

export type CommitKind = "feature" | "fix" | "refactor" | "test" | "docs" | "chore" | "unknown";

interface CommitRow {
    readonly id: unknown;
    readonly message?: string;
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
            expectedImpact: "More useful insight output and fewer slow SurrealQL reads.",
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
        const commitKey = recordKeyPart(commit.id, "commit");
        if (!commitKey) return [];
        const kind = classifyCommitMessage(commit.message);
        return [{
            commitKey,
            repositoryKey: recordKeyPart(commit.repository, "repository"),
            kind,
            confidence: kind === "unknown" ? "low" : "high",
            message: commit.message ?? null,
            ts: isoTimestamp(commit.ts),
        } satisfies CommitClassification];
    });
    const filesByCommit = new Map<string, Set<string>>();
    for (const touched of input.touched) {
        const commitKey = recordKeyPart(touched.in, "commit");
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

function classificationStatement(row: CommitClassification): string {
    return `UPSERT ${recordRef("commit_classification", safeKeyPart(row.commitKey))} MERGE ${surrealObject([
        ["commit", recordRef("commit", row.commitKey)],
        ["repository", row.repositoryKey ? recordRef("repository", row.repositoryKey) : "NONE"],
        ["kind", surrealString(row.kind)],
        ["confidence", surrealString(row.confidence)],
        ["message", surrealOptionString(row.message)],
        ["labels", surrealJsonOption({ source: "closure" })],
        ["metrics", surrealJsonOption({})],
        ["ts", surrealDate(row.ts)],
    ])};`;
}

function fixChainStatements(row: FixChain): string[] {
    const edgeKey = `${safeKeyPart(row.featureKey)}__${safeKeyPart(row.fixKey)}`;
    return [
        `DELETE ${recordRef("later_fixed_by", edgeKey)};`,
        `RELATE ${recordRef("commit", row.featureKey)}->later_fixed_by:\`${edgeKey}\`->${recordRef("commit", row.fixKey)} SET ${[
            ["repository", row.repositoryKey ? recordRef("repository", row.repositoryKey) : "NONE"],
            ["overlap_files", surrealJsonOption(row.overlapFiles)],
            ["overlap_count", row.overlapFiles.length.toString(10)],
            ["days_between", Number(row.daysBetween.toFixed(3)).toString()],
            ["confidence", surrealString(row.confidence)],
            ["reason", surrealOptionString(row.reason)],
            ["ts", surrealDate(row.ts)],
        ].map(([name, value]) => `${name} = ${value}`).join(", ")};`,
    ];
}

function skillCandidateStatements(row: SkillCandidate): string[] {
    const candidateRef = recordRef("skill_candidate", row.key);
    const statements = [
        `UPSERT ${candidateRef} MERGE ${surrealObject([
            ["name", surrealString(row.name)],
            ["trigger_pattern", surrealString(row.triggerPattern)],
            ["suspected_gap", surrealString(row.suspectedGap)],
            ["proposed_behavior", surrealString(row.proposedBehavior)],
            ["confidence", surrealString(row.confidence)],
            ["expected_impact", surrealOptionString(row.expectedImpact)],
            ["status", surrealString("candidate")],
            ["labels", surrealJsonOption({ source: "closure" })],
            ["metrics", surrealJsonOption(row.metrics)],
            ["created_at", "time::now()"],
        ])};`,
    ];
    for (const commitKey of row.evidenceCommits) {
        const edgeKey = `${safeKeyPart(commitKey)}__${row.key}`;
        statements.push(
            `DELETE ${recordRef("suggests_skill", edgeKey)};`,
            `RELATE ${recordRef("commit", commitKey)}->suggests_skill:\`${edgeKey}\`->${candidateRef} SET reason = ${surrealOptionString(row.triggerPattern)}, evidence = ${surrealJsonOption(row.metrics)}, confidence = ${surrealString(row.confidence)}, ts = time::now();`,
        );
    }
    return statements;
}

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

const closureWatermarkId = (): string =>
    recordLiteral("ingest_file_state", stableDigest(`closure|${CLOSURE_WATERMARK_PATH}`));

const closureInputFingerprint = (input: {
    readonly commits: readonly CommitRow[];
    readonly touched: readonly TouchedRow[];
    readonly sessionHealth: readonly SessionHealthRow[];
    readonly sinceDays: number | undefined;
}): string => {
    const parts: string[] = [`since=${input.sinceDays ?? ""}`];
    parts.push(`commits=${input.commits.length}`);
    for (const c of input.commits) {
        parts.push(`c|${recordKeyPart(c.id, "commit") ?? ""}|${isoTimestamp(c.ts)}|${c.message ?? ""}|${recordKeyPart(c.repository, "repository") ?? ""}`);
    }
    parts.push(`touched=${input.touched.length}`);
    for (const t of input.touched) {
        parts.push(`t|${recordKeyPart(t.in, "commit") ?? ""}|${t.path ?? ""}`);
    }
    parts.push(`health=${input.sessionHealth.length}`);
    for (const h of input.sessionHealth) {
        parts.push(`h|${recordKeyPart(h.session, "session") ?? ""}|${h.tool_errors ?? ""}|${h.user_corrections ?? ""}|${h.interruptions ?? ""}|${h.context_pressure ?? ""}`);
    }
    // 32-hex digest keeps collisions astronomically unlikely for this corpus.
    return stableDigest(parts.join("\n"), 32);
};

const loadClosureWatermark = (
    db: SurrealClientShape,
): Effect.Effect<string | undefined, DbError> =>
    Effect.gen(function* () {
        const rows = (yield* db.query<[Array<{ sha?: string }>]>(
            `SELECT sha FROM ingest_file_state WHERE source_kind = ${surrealString(CLOSURE_WATERMARK_SOURCE)};`,
        ))?.[0] ?? [];
        const sha = rows[0]?.sha;
        return typeof sha === "string" ? sha : undefined;
    });

const upsertClosureWatermark = (
    db: SurrealClientShape,
    digest: string,
): Effect.Effect<void, DbError> =>
    executeStatementsWith(
        db,
        [
            `UPSERT ${closureWatermarkId()} CONTENT { path: ${surrealString(CLOSURE_WATERMARK_PATH)}, source_kind: ${surrealString(CLOSURE_WATERMARK_SOURCE)}, sha: ${surrealString(digest)}, ingested_at: time::now() };`,
        ],
        { chunkSize: 1 },
    );

export const deriveClosure = (
    opts: { sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<ClosureStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const forceRederive = process.env.AX_REDERIVE_CLOSURE === "1";
        const [commits, touched, sessionHealth, storedDigest] = yield* Effect.all([
            db.query<[CommitRow[]]>(`
SELECT id, message, repository, type::string(ts) AS ts
FROM commit
${sinceWhereClause(opts.sinceDays)}
ORDER BY ts ASC;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[TouchedRow[]]>(`
SELECT in, out, out.path AS path
FROM touched;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[SessionHealthRow[]]>(`
SELECT session, tool_errors, user_corrections, interruptions, context_pressure
FROM session_health;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            forceRederive
                ? (Effect.undefined as Effect.Effect<string | undefined>)
                : loadClosureWatermark(db),
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
        const statements = [
            ...rows.classifications.map(classificationStatement),
            ...rows.fixChains.flatMap(fixChainStatements),
            ...rows.skillCandidates.flatMap(skillCandidateStatements),
        ];
        yield* db.query("DELETE later_fixed_by;DELETE suggests_skill;DELETE skill_candidate;DELETE commit_classification;").pipe(
            Effect.withSpan("closure.delete"),
        );
        yield* executeStatementsWith(db, statements, { chunkSize: 500, label: "closure" });
        yield* upsertClosureWatermark(db, digest);
        return stats;
    });

if (import.meta.main) {
    const sinceArg = process.argv.find((a) => a.startsWith("--since="));
    const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : undefined;
    await Effect.runPromise(
        deriveClosure({ sinceDays }).pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<ClosureStats>,
    );
}

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { BaseStageStats, IngestContext, sinceDaysFromCtx, sinceWhereClause, StageMeta } from "./stage/types.ts";
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

export const closureStage: StageDef<ClosureStageStats, SurrealClient> = {
    meta: StageMeta.make({ key: "closure", deps: ["signals"], tags: ["derive"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* deriveClosure({ sinceDays });
            return ClosureStageStats.make({
                durationMs: Date.now() - t0,
                summary: `classified ${result.commitClassifications} commits, ${result.skillCandidates} skill candidates`,
                commitClassifications: result.commitClassifications,
                skillCandidates: result.skillCandidates,
            });
        }),
};
