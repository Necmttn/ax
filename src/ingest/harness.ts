import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { ProcessService } from "../lib/process.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { buildProjectHarnessReport } from "../project/harness.ts";
import type {
    AgentToolingSignal,
    GuidanceRevision,
    GuidanceSource,
    HarnessLearningCandidate,
    InterventionObservation,
    InterventionSuggestion,
    ProjectHarnessReport,
    StackSignal,
} from "../project/types.ts";
import { recordRef } from "./evidence-writers.ts";
import { surrealDate, surrealJsonOption, surrealObject, surrealOptionString, surrealString } from "../lib/shared/surql.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";

export interface HarnessIngestStats {
    readonly guidanceSources: number;
    readonly guidanceRevisions: number;
    readonly stacks: number;
    readonly agentTooling: number;
    readonly harnessLearnings: number;
    readonly interventions: number;
    readonly interventionObservations: number;
}

const sqlBool = (value: boolean): string => value ? "true" : "false";

const safeKeyPart = (value: string): string => {
    const sanitized = value
        .replace(/:/g, "__")
        .replace(/[^a-zA-Z0-9_]+/g, "_")
        .replace(/_{3,}/g, "__")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized.slice(0, 96) : Bun.hash(value).toString(16);
};

export const guidanceSourceKey = (source: Pick<GuidanceSource, "path">): string =>
    `${safeKeyPart(source.path)}__${Bun.hash(source.path).toString(16).slice(0, 16)}`;

export const guidanceRevisionKey = (revision: Pick<GuidanceRevision, "sourcePath" | "contentHash">): string =>
    `${safeKeyPart(revision.sourcePath).slice(0, 72)}__${revision.contentHash}`;

export const stackKey = (signal: Pick<StackSignal, "name">): string =>
    safeKeyPart(signal.name.toLowerCase());

export const agentToolingKey = (tool: Pick<AgentToolingSignal, "name" | "layer">): string =>
    `${safeKeyPart(tool.layer)}__${safeKeyPart(tool.name)}__${Bun.hash(`${tool.layer}:${tool.name}`).toString(16).slice(0, 12)}`;

export const harnessLearningKey = (learning: Pick<HarnessLearningCandidate, "title" | "harnessLayer">): string =>
    `${safeKeyPart(learning.harnessLayer)}__${safeKeyPart(learning.title)}__${Bun.hash(learning.title).toString(16).slice(0, 12)}`;

export const interventionKey = (intervention: Pick<InterventionSuggestion, "title" | "strength">): string =>
    `${safeKeyPart(intervention.strength)}__${safeKeyPart(intervention.title)}__${Bun.hash(`${intervention.strength}:${intervention.title}`).toString(16).slice(0, 12)}`;

export const interventionObservationKey = (observation: Pick<InterventionObservation, "target">, observedAt: string): string =>
    `${safeKeyPart(observation.target)}__${Bun.hash(`${observation.target}:${observedAt}`).toString(16).slice(0, 16)}`;

function guidanceSourceStatement(source: GuidanceSource): string {
    return `UPSERT ${recordRef("guidance_source", guidanceSourceKey(source))} MERGE ${surrealObject([
        ["path", surrealString(source.path)],
        ["kind", surrealString(source.kind)],
        ["scope", surrealString(source.scope)],
        ["provider", surrealString(source.provider)],
        ["evidence_strength", surrealString(source.evidenceStrength)],
        ["git_root", surrealOptionString(source.gitRoot)],
        ["tracked", sqlBool(source.tracked)],
        ["observed_at", "time::now()"],
    ])};`;
}

function guidanceRevisionStatement(revision: GuidanceRevision): string {
    return `UPSERT ${recordRef("guidance_revision", guidanceRevisionKey(revision))} MERGE ${surrealObject([
        ["source", recordRef("guidance_source", guidanceSourceKey({ path: revision.sourcePath }))],
        ["source_path", surrealString(revision.sourcePath)],
        ["scope", surrealString(revision.scope)],
        ["content_hash", surrealString(revision.contentHash)],
        ["evidence_strength", surrealString(revision.evidenceStrength)],
        ["commit_evidence", surrealOptionString(revision.commitEvidence)],
        ["file_evidence", surrealOptionString(revision.fileEvidence)],
        ["observed_at", surrealDate(revision.observedAt)],
    ])};`;
}

function stackStatement(signal: StackSignal): string {
    return `UPSERT ${recordRef("stack", stackKey(signal))} MERGE ${surrealObject([
        ["name", surrealString(signal.name)],
        ["aliases", "NONE"],
        ["labels", surrealJsonOption({ confidence: signal.confidence, evidence: signal.evidence })],
        ["updated_at", "time::now()"],
    ])};`;
}

function agentToolingStatement(tool: AgentToolingSignal): string {
    return `UPSERT ${recordRef("agent_tooling", agentToolingKey(tool))} MERGE ${surrealObject([
        ["name", surrealString(tool.name)],
        ["layer", surrealString(tool.layer)],
        ["source", surrealString(tool.source)],
        ["evidence", surrealOptionString(tool.evidence)],
        ["labels", "NONE"],
        ["updated_at", "time::now()"],
    ])};`;
}

function harnessLearningStatement(learning: HarnessLearningCandidate): string {
    return `UPSERT ${recordRef("harness_learning", harnessLearningKey(learning))} MERGE ${surrealObject([
        ["title", surrealString(learning.title)],
        ["status", surrealString("local")],
        ["problem", surrealString(learning.problem)],
        ["pattern", surrealString(learning.pattern)],
        ["harness_layer", surrealString(learning.harnessLayer)],
        ["applicability", surrealJsonOption(learning.appliesWhen)],
        ["counterconditions", surrealJsonOption(learning.avoidWhen)],
        ["evidence_summary", surrealJsonOption(learning.evidenceSummary)],
        ["observed_effect", "NONE"],
        ["side_effects", "NONE"],
        ["confidence", surrealString(learning.confidence)],
        ["privacy_level", surrealString("local")],
        ["suggested_intervention", surrealOptionString(learning.suggestedIntervention)],
        ["risk", surrealJsonOption(learning.risk)],
        ["updated_at", "time::now()"],
    ])};`;
}

function interventionStatement(intervention: InterventionSuggestion): string {
    return `UPSERT ${recordRef("intervention", interventionKey(intervention))} MERGE ${surrealObject([
        ["title", surrealString(intervention.title)],
        ["status", surrealString("suggested")],
        ["strength", surrealString(intervention.strength)],
        ["risk", "NONE"],
        ["expected_effect", surrealOptionString(intervention.expectedEffect)],
        ["review_criteria", surrealJsonOption(intervention.reviewCriteria)],
        ["approval_required", sqlBool(intervention.approvalRequired)],
        ["updated_at", "time::now()"],
    ])};`;
}

function interventionObservationStatement(
    observation: InterventionObservation,
    intervention: InterventionSuggestion | undefined,
    observedAt: string,
): string {
    return `UPSERT ${recordRef("intervention_observation", interventionObservationKey(observation, observedAt))} MERGE ${surrealObject([
        ["intervention", intervention ? recordRef("intervention", interventionKey(intervention)) : "NONE"],
        ["target", surrealString(observation.target)],
        ["status", surrealString(observation.status)],
        ["metrics_before", surrealJsonOption(observation.before)],
        ["metrics_after", surrealJsonOption(observation.after)],
        ["metrics", surrealJsonOption(observation.metrics)],
        ["notes", surrealJsonOption(observation.notes)],
        ["observed_at", surrealDate(observedAt)],
    ])};`;
}

export function buildHarnessIngestStatements(report: ProjectHarnessReport, observedAt = report.generatedAt): string[] {
    return [
        ...report.guidanceSources.map(guidanceSourceStatement),
        ...report.guidanceRevisions.map(guidanceRevisionStatement),
        ...report.stacks.map(stackStatement),
        ...report.agentTooling.map(agentToolingStatement),
        ...report.learningCandidates.map(harnessLearningStatement),
        ...report.interventions.map(interventionStatement),
        ...report.observations.map((observation, index) =>
            interventionObservationStatement(observation, report.interventions[index], observedAt),
        ),
    ];
}

export const ingestHarness = (): Effect.Effect<HarnessIngestStats, DbError, SurrealClient | ProcessService> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const report = yield* buildProjectHarnessReport();
        const statements = buildHarnessIngestStatements(report);
        yield* executeStatementsWith(db, statements);
        return {
            guidanceSources: report.guidanceSources.length,
            guidanceRevisions: report.guidanceRevisions.length,
            stacks: report.stacks.length,
            agentTooling: report.agentTooling.length,
            harnessLearnings: report.learningCandidates.length,
            interventions: report.interventions.length,
            interventionObservations: report.observations.length,
        };
    });

if (import.meta.main) {
    await Effect.runPromise(
        ingestHarness().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<HarnessIngestStats>,
    );
}
