import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef } from "./evidence-writers.ts";
import { surrealDate, surrealJsonOption, surrealObject, surrealOptionString, surrealString } from "../lib/shared/surql.ts";

type TimestampInput = Date | string | { readonly constructor: { readonly name: string }; toString(): string };

export type CommitKind = "feature" | "fix" | "refactor" | "test" | "docs" | "chore" | "unknown";

interface CommitRow {
    readonly id: unknown;
    readonly message?: string | null;
    readonly repository?: unknown;
    readonly ts?: TimestampInput | null;
}

interface TouchedRow {
    readonly in?: unknown;
    readonly out?: unknown;
    readonly path?: string | null;
}

interface SessionHealthRow {
    readonly session?: unknown;
    readonly tool_errors?: number | null;
    readonly user_corrections?: number | null;
    readonly interruptions?: number | null;
    readonly context_pressure?: string | null;
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

const safeKeyPart = (value: string): string => {
    const sanitized = value
        .replace(/:/g, "__")
        .replace(/[^a-zA-Z0-9_]+/g, "_")
        .replace(/_{3,}/g, "__")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized.slice(0, 96) : Bun.hash(value).toString(16);
};

const isoTimestamp = (value: TimestampInput | null | undefined): string => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && value.constructor.name === "DateTime") return String(value);
    return new Date(0).toISOString();
};

const recordKeyPart = (value: unknown, expectedTable?: string): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
        let raw = value.trim();
        const prefix = expectedTable ? `${expectedTable}:` : null;
        if (prefix && raw.startsWith(prefix)) raw = raw.slice(prefix.length);
        else if (raw.includes(":")) raw = raw.slice(raw.indexOf(":") + 1);
        if ((raw.startsWith("`") && raw.endsWith("`")) || (raw.startsWith("⟨") && raw.endsWith("⟩"))) raw = raw.slice(1, -1);
        return raw.length > 0 ? raw : null;
    }
    if (typeof value === "object" && "id" in value) {
        const id = (value as { id: unknown }).id;
        return id === null || id === undefined ? null : String(id);
    }
    return null;
};

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
    const gapSessions = input.sessionHealth.filter((row) =>
        (row.tool_errors ?? 0) >= 5 || (row.user_corrections ?? 0) > 0 || row.context_pressure === "high",
    );
    if (gapSessions.length >= 3) {
        candidatesByName.set("Session closure quality guardrail", {
            key: "session_closure_quality_guardrail",
            name: "Session closure quality guardrail",
            triggerPattern: "multiple high-pressure/error/correction sessions",
            suspectedGap: "Sessions are ending with enough risk that closure needs an explicit quality gate.",
            proposedBehavior: "Before final response, check edits, command outcomes, verification gaps, and unresolved high-pressure sessions.",
            confidence: gapSessions.length >= 10 ? "high" : "medium",
            expectedImpact: "Fewer user redirects and post-closure fixes.",
            evidenceCommits: [],
            metrics: { risky_session_count: gapSessions.length },
        });
    }

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

const sinceWhere = (sinceDays: number | undefined): string =>
    sinceDays && sinceDays > 0 ? `WHERE ts > time::now() - ${sinceDays}d` : "";

export const deriveClosure = (
    opts: { sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<ClosureStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [commits, touched, sessionHealth] = yield* Effect.all([
            db.query<[CommitRow[]]>(`
SELECT id, message, repository, type::string(ts) AS ts
FROM commit
${sinceWhere(opts.sinceDays)}
ORDER BY ts ASC;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[TouchedRow[]]>(`
SELECT in, out, out.path AS path
FROM touched;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[SessionHealthRow[]]>(`
SELECT session, tool_errors, user_corrections, interruptions, context_pressure
FROM session_health;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
        ], { concurrency: 3 });
        const rows = deriveClosureRows({ commits, touched, sessionHealth });
        const statements = [
            ...rows.classifications.map(classificationStatement),
            ...rows.fixChains.flatMap(fixChainStatements),
            ...rows.skillCandidates.flatMap(skillCandidateStatements),
        ];
        yield* db.query("DELETE later_fixed_by;DELETE suggests_skill;DELETE skill_candidate;DELETE commit_classification;");
        for (let i = 0; i < statements.length; i += 500) {
            yield* db.query(statements.slice(i, i + 500).join(""));
        }
        return {
            commitClassifications: rows.classifications.length,
            fixChains: rows.fixChains.length,
            skillCandidates: rows.skillCandidates.length,
        };
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
