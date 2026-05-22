import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef } from "./evidence-writers.ts";
import { surrealJsonOption, surrealObject, surrealOptionString, surrealString } from "../lib/shared/surql.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";
import { recordKeyPart, safeKeyPart } from "../lib/shared/derive-keys.ts";

interface SkillCandidateRow {
    readonly id?: unknown;
    readonly name?: string;
    readonly trigger_pattern?: string;
    readonly suspected_gap?: string;
    readonly proposed_behavior?: string;
    readonly confidence?: string;
    readonly metrics?: string;
}

interface StackRow {
    readonly id?: unknown;
    readonly name?: string;
    readonly kind?: string;
}

interface HarnessLearningRow {
    readonly id?: unknown;
    readonly name?: string;
    readonly pattern?: string;
    readonly scope?: string;
    readonly confidence?: string;
}

export interface LearningRegistryStats {
    readonly gotchas: number;
    readonly tasteSignals: number;
    readonly workflows: number;
    readonly learningFeedback: number;
    readonly learningMatches: number;
    readonly adoptions: number;
}

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
        statements.push(`UPSERT ${recordRef("gotcha", gotchaKey)} MERGE ${surrealObject([
            ["name", surrealString(candidate.name)],
            ["kind", surrealString("skill_candidate")],
            ["pattern", surrealString(candidate.trigger_pattern ?? candidate.name)],
            ["mitigation", surrealString(candidate.proposed_behavior ?? "Add a focused skill or guardrail.")],
            ["strength", surrealString(candidate.confidence ?? "low")],
            ["labels", surrealJsonOption({ source: "learning_registry", skill_candidate: candidateKey })],
            ["metrics", surrealJsonOption({ suspected_gap: candidate.suspected_gap, raw_metrics: candidate.metrics })],
            ["created_at", "time::now()"],
        ])};`);
        gotchas += 1;

        statements.push(`UPSERT ${recordRef("taste_signal", gotchaKey)} MERGE ${surrealObject([
            ["subject", surrealString(candidate.name)],
            ["preference", surrealString(candidate.proposed_behavior ?? candidate.trigger_pattern ?? candidate.name)],
            ["polarity", surrealString("positive")],
            ["strength", surrealString(candidate.confidence ?? "low")],
            ["evidence", surrealJsonOption({ source: "skill_candidate", candidate: candidateKey })],
            ["created_at", "time::now()"],
        ])};`);
        tasteSignals += 1;

        statements.push(`UPSERT ${recordRef("learning_feedback", gotchaKey)} MERGE ${surrealObject([
            ["target", surrealString(candidate.name)],
            ["signal", surrealString(candidate.suspected_gap ?? "candidate derived from closure evidence")],
            ["sentiment", surrealString("needs_action")],
            ["evidence", surrealJsonOption({ source: "skill_candidate", candidate: candidateKey })],
            ["created_at", "time::now()"],
        ])};`);
        learningFeedback += 1;

        statements.push(`UPSERT ${recordRef("adoption", gotchaKey)} MERGE ${surrealObject([
            ["target", surrealString(candidate.name)],
            ["scope", surrealString("local")],
            ["status", surrealString("draft")],
            ["evidence", surrealJsonOption({ source: "skill_candidate", candidate: candidateKey, hosted_share: "disabled" })],
            ["created_at", "time::now()"],
        ])};`);
        adoptions += 1;

        for (const stack of input.stacks.slice(0, 8)) {
            const stackKey = recordKeyPart(stack.id, "stack");
            if (!stackKey) continue;
            const matchKey = `${gotchaKey}__${safeKeyPart(stackKey)}`;
            const score = workflowName.includes("schema") && /surreal/i.test(stack.name ?? "") ? 0.9 : 0.45;
            statements.push(`UPSERT ${recordRef("learning_match", matchKey)} MERGE ${surrealObject([
                ["learning", "NONE"],
                ["skill_candidate", recordRef("skill_candidate", candidateKey)],
                ["stack", recordRef("stack", stackKey)],
                ["workflow", recordRef("workflow", workflowName)],
                ["score", score.toString()],
                ["reason", surrealOptionString(`Candidate ${candidate.name} matched stack ${stack.name ?? stackKey}`)],
                ["labels", surrealJsonOption({ source: "learning_registry" })],
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
        statements.push(`UPSERT ${recordRef("learning_match", matchKey)} MERGE ${surrealObject([
            ["learning", recordRef("harness_learning", learningKey)],
            ["skill_candidate", "NONE"],
            ["stack", "NONE"],
            ["workflow", recordRef("workflow", workflowName)],
            ["score", "0.75"],
            ["reason", surrealOptionString(learning.pattern ?? "Harness learning matched to guardrail workflow")],
            ["labels", surrealJsonOption({ source: "learning_registry", scope: learning.scope })],
            ["created_at", "time::now()"],
        ])};`);
        learningMatches += 1;
    }

    for (const workflowName of workflowNames) {
        statements.push(`UPSERT ${recordRef("workflow", workflowName)} MERGE ${surrealObject([
            ["name", surrealString(workflowName)],
            ["kind", surrealString("local_learning")],
            ["description", surrealOptionString(`Derived local learning workflow: ${workflowName}`)],
            ["labels", surrealJsonOption({ source: "learning_registry" })],
            ["metrics", surrealJsonOption({ hosted_share: "disabled", auto_publish: false })],
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
        yield* executeStatementsWith(db, statements, { chunkSize: 500 });
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
