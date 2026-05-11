import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef } from "./evidence-writers.ts";

interface SkillCandidateRow {
    readonly id?: unknown;
    readonly name?: string | null;
    readonly trigger_pattern?: string | null;
    readonly suspected_gap?: string | null;
    readonly proposed_behavior?: string | null;
    readonly confidence?: string | null;
    readonly metrics?: string | null;
}

interface StackRow {
    readonly id?: unknown;
    readonly name?: string | null;
    readonly kind?: string | null;
}

interface HarnessLearningRow {
    readonly id?: unknown;
    readonly name?: string | null;
    readonly pattern?: string | null;
    readonly scope?: string | null;
    readonly confidence?: string | null;
}

export interface LearningRegistryStats {
    readonly gotchas: number;
    readonly tasteSignals: number;
    readonly workflows: number;
    readonly learningFeedback: number;
    readonly learningMatches: number;
    readonly adoptions: number;
}

const sqlString = (value: string): string => JSON.stringify(value);
const sqlOptionString = (value: string | null | undefined): string =>
    value === null || value === undefined ? "NONE" : sqlString(value);
const sqlJsonOption = (value: unknown | null | undefined): string =>
    value === null || value === undefined ? "NONE" : sqlString(JSON.stringify(value) ?? "null");
const sqlObject = (fields: readonly (readonly [string, string])[]): string =>
    `{ ${fields.map(([name, value]) => `${name}: ${value}`).join(", ")} }`;

const safeKeyPart = (value: string): string => {
    const sanitized = value
        .replace(/:/g, "__")
        .replace(/[^a-zA-Z0-9_]+/g, "_")
        .replace(/_{3,}/g, "__")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized.slice(0, 96) : Bun.hash(value).toString(16);
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

function workflowForCandidate(candidate: SkillCandidateRow): string {
    const text = `${candidate.name ?? ""} ${candidate.trigger_pattern ?? ""} ${candidate.suspected_gap ?? ""}`.toLowerCase();
    if (text.includes("schema") || text.includes("surreal")) return "schema_change";
    if (text.includes("ingest")) return "ingest_pipeline";
    if (text.includes("query")) return "graph_query_dogfood";
    if (text.includes("closure")) return "closure_quality";
    return "post_feature_verification";
}

export function buildLearningRegistryStatements(input: {
    readonly skillCandidates: readonly SkillCandidateRow[];
    readonly stacks: readonly StackRow[];
    readonly harnessLearnings: readonly HarnessLearningRow[];
}): { readonly statements: string[]; readonly stats: LearningRegistryStats } {
    const statements: string[] = [
        "DELETE gotcha;DELETE taste_signal;DELETE workflow;DELETE learning_feedback;DELETE learning_match;DELETE adoption;",
    ];
    const workflowNames = new Set<string>();
    let gotchas = 0;
    let tasteSignals = 0;
    let learningFeedback = 0;
    let learningMatches = 0;
    let adoptions = 0;

    for (const candidate of input.skillCandidates) {
        if (!candidate.name) continue;
        const candidateKey = recordKeyPart(candidate.id, "skill_candidate") ?? safeKeyPart(candidate.name);
        const workflowName = workflowForCandidate(candidate);
        workflowNames.add(workflowName);
        const gotchaKey = safeKeyPart(candidate.name);
        statements.push(`UPSERT ${recordRef("gotcha", gotchaKey)} MERGE ${sqlObject([
            ["name", sqlString(candidate.name)],
            ["kind", sqlString("skill_candidate")],
            ["pattern", sqlString(candidate.trigger_pattern ?? candidate.name)],
            ["mitigation", sqlString(candidate.proposed_behavior ?? "Add a focused skill or guardrail.")],
            ["strength", sqlString(candidate.confidence ?? "low")],
            ["labels", sqlJsonOption({ source: "learning_registry", skill_candidate: candidateKey })],
            ["metrics", sqlJsonOption({ suspected_gap: candidate.suspected_gap, raw_metrics: candidate.metrics })],
            ["created_at", "time::now()"],
        ])};`);
        gotchas += 1;

        statements.push(`UPSERT ${recordRef("taste_signal", gotchaKey)} MERGE ${sqlObject([
            ["subject", sqlString(candidate.name)],
            ["preference", sqlString(candidate.proposed_behavior ?? candidate.trigger_pattern ?? candidate.name)],
            ["polarity", sqlString("positive")],
            ["strength", sqlString(candidate.confidence ?? "low")],
            ["evidence", sqlJsonOption({ source: "skill_candidate", candidate: candidateKey })],
            ["created_at", "time::now()"],
        ])};`);
        tasteSignals += 1;

        statements.push(`UPSERT ${recordRef("learning_feedback", gotchaKey)} MERGE ${sqlObject([
            ["target", sqlString(candidate.name)],
            ["signal", sqlString(candidate.suspected_gap ?? "candidate derived from closure evidence")],
            ["sentiment", sqlString("needs_action")],
            ["evidence", sqlJsonOption({ source: "skill_candidate", candidate: candidateKey })],
            ["created_at", "time::now()"],
        ])};`);
        learningFeedback += 1;

        statements.push(`UPSERT ${recordRef("adoption", gotchaKey)} MERGE ${sqlObject([
            ["target", sqlString(candidate.name)],
            ["scope", sqlString("local")],
            ["status", sqlString("draft")],
            ["evidence", sqlJsonOption({ source: "skill_candidate", candidate: candidateKey, hosted_share: "disabled" })],
            ["created_at", "time::now()"],
        ])};`);
        adoptions += 1;

        for (const stack of input.stacks.slice(0, 8)) {
            const stackKey = recordKeyPart(stack.id, "stack");
            if (!stackKey) continue;
            const matchKey = `${gotchaKey}__${safeKeyPart(stackKey)}`;
            const score = workflowName.includes("schema") && /surreal/i.test(stack.name ?? "") ? 0.9 : 0.45;
            statements.push(`UPSERT ${recordRef("learning_match", matchKey)} MERGE ${sqlObject([
                ["learning", "NONE"],
                ["skill_candidate", recordRef("skill_candidate", candidateKey)],
                ["stack", recordRef("stack", stackKey)],
                ["workflow", recordRef("workflow", workflowName)],
                ["score", score.toString()],
                ["reason", sqlOptionString(`Candidate ${candidate.name} matched stack ${stack.name ?? stackKey}`)],
                ["labels", sqlJsonOption({ source: "learning_registry" })],
                ["created_at", "time::now()"],
            ])};`);
            learningMatches += 1;
        }
    }

    for (const learning of input.harnessLearnings) {
        if (!learning.name) continue;
        const learningKey = recordKeyPart(learning.id, "harness_learning");
        const workflowName = "harness_guardrail";
        workflowNames.add(workflowName);
        if (!learningKey) continue;
        const matchKey = `${safeKeyPart(learningKey)}__${workflowName}`;
        statements.push(`UPSERT ${recordRef("learning_match", matchKey)} MERGE ${sqlObject([
            ["learning", recordRef("harness_learning", learningKey)],
            ["skill_candidate", "NONE"],
            ["stack", "NONE"],
            ["workflow", recordRef("workflow", workflowName)],
            ["score", "0.75"],
            ["reason", sqlOptionString(learning.pattern ?? "Harness learning matched to guardrail workflow")],
            ["labels", sqlJsonOption({ source: "learning_registry", scope: learning.scope })],
            ["created_at", "time::now()"],
        ])};`);
        learningMatches += 1;
    }

    for (const workflowName of workflowNames) {
        statements.push(`UPSERT ${recordRef("workflow", workflowName)} MERGE ${sqlObject([
            ["name", sqlString(workflowName)],
            ["kind", sqlString("local_learning")],
            ["description", sqlOptionString(`Derived local learning workflow: ${workflowName}`)],
            ["labels", sqlJsonOption({ source: "learning_registry" })],
            ["metrics", sqlJsonOption({ hosted_share: "disabled", auto_publish: false })],
            ["created_at", "time::now()"],
        ])};`);
    }

    return {
        statements,
        stats: {
            gotchas,
            tasteSignals,
            workflows: workflowNames.size,
            learningFeedback,
            learningMatches,
            adoptions,
        },
    };
}

export const deriveLearningRegistry = (): Effect.Effect<LearningRegistryStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [skillCandidates, stacks, harnessLearnings] = yield* Effect.all([
            db.query<[SkillCandidateRow[]]>("SELECT id, name, trigger_pattern, suspected_gap, proposed_behavior, confidence, metrics FROM skill_candidate;").pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[StackRow[]]>("SELECT id, name, kind FROM stack;").pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[HarnessLearningRow[]]>("SELECT id, name, pattern, scope, confidence FROM harness_learning;").pipe(Effect.map((rows) => rows?.[0] ?? [])),
        ], { concurrency: 3 });
        const { statements, stats } = buildLearningRegistryStatements({ skillCandidates, stacks, harnessLearnings });
        for (let i = 0; i < statements.length; i += 500) {
            yield* db.query(statements.slice(i, i + 500).join(""));
        }
        return stats;
    });

if (import.meta.main) {
    await Effect.runPromise(
        deriveLearningRegistry().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<LearningRegistryStats>,
    );
}
