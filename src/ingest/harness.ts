import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
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

type JsonInput = unknown;

export interface HarnessIngestStats {
    readonly guidanceSources: number;
    readonly guidanceRevisions: number;
    readonly stacks: number;
    readonly agentTooling: number;
    readonly harnessLearnings: number;
    readonly interventions: number;
    readonly interventionObservations: number;
}

const sqlString = (value: string): string => JSON.stringify(value);

const sqlOptionString = (value: string | null | undefined): string =>
    value === null || value === undefined ? "NONE" : sqlString(value);

const sqlJsonString = (value: JsonInput): string => sqlString(JSON.stringify(value) ?? "null");

const sqlJsonOption = (value: JsonInput | null | undefined): string =>
    value === null || value === undefined ? "NONE" : sqlJsonString(value);

const sqlDate = (value: string): string => `d${JSON.stringify(value)}`;

const sqlBool = (value: boolean): string => value ? "true" : "false";

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
    return `UPSERT ${recordRef("guidance_source", guidanceSourceKey(source))} MERGE ${sqlObject([
        ["path", sqlString(source.path)],
        ["kind", sqlString(source.kind)],
        ["scope", sqlString(source.scope)],
        ["provider", sqlString(source.provider)],
        ["evidence_strength", sqlString(source.evidenceStrength)],
        ["git_root", sqlOptionString(source.gitRoot)],
        ["tracked", sqlBool(source.tracked)],
        ["observed_at", "time::now()"],
    ])};`;
}

function guidanceRevisionStatement(revision: GuidanceRevision): string {
    return `UPSERT ${recordRef("guidance_revision", guidanceRevisionKey(revision))} MERGE ${sqlObject([
        ["source", recordRef("guidance_source", guidanceSourceKey({ path: revision.sourcePath }))],
        ["source_path", sqlString(revision.sourcePath)],
        ["scope", sqlString(revision.scope)],
        ["content_hash", sqlString(revision.contentHash)],
        ["evidence_strength", sqlString(revision.evidenceStrength)],
        ["commit_evidence", sqlOptionString(revision.commitEvidence)],
        ["file_evidence", sqlOptionString(revision.fileEvidence)],
        ["observed_at", sqlDate(revision.observedAt)],
    ])};`;
}

function stackStatement(signal: StackSignal): string {
    return `UPSERT ${recordRef("stack", stackKey(signal))} MERGE ${sqlObject([
        ["name", sqlString(signal.name)],
        ["aliases", "NONE"],
        ["labels", sqlJsonOption({ confidence: signal.confidence, evidence: signal.evidence })],
        ["updated_at", "time::now()"],
    ])};`;
}

function agentToolingStatement(tool: AgentToolingSignal): string {
    return `UPSERT ${recordRef("agent_tooling", agentToolingKey(tool))} MERGE ${sqlObject([
        ["name", sqlString(tool.name)],
        ["layer", sqlString(tool.layer)],
        ["source", sqlString(tool.source)],
        ["evidence", sqlOptionString(tool.evidence)],
        ["labels", "NONE"],
        ["updated_at", "time::now()"],
    ])};`;
}

function harnessLearningStatement(learning: HarnessLearningCandidate): string {
    return `UPSERT ${recordRef("harness_learning", harnessLearningKey(learning))} MERGE ${sqlObject([
        ["title", sqlString(learning.title)],
        ["status", sqlString("local")],
        ["problem", sqlString(learning.problem)],
        ["pattern", sqlString(learning.pattern)],
        ["harness_layer", sqlString(learning.harnessLayer)],
        ["applicability", sqlJsonOption(learning.appliesWhen)],
        ["counterconditions", sqlJsonOption(learning.avoidWhen)],
        ["evidence_summary", sqlJsonOption(learning.evidenceSummary)],
        ["observed_effect", "NONE"],
        ["side_effects", "NONE"],
        ["confidence", sqlString(learning.confidence)],
        ["privacy_level", sqlString("local")],
        ["suggested_intervention", sqlOptionString(learning.suggestedIntervention)],
        ["risk", sqlJsonOption(learning.risk)],
        ["updated_at", "time::now()"],
    ])};`;
}

function interventionStatement(intervention: InterventionSuggestion): string {
    return `UPSERT ${recordRef("intervention", interventionKey(intervention))} MERGE ${sqlObject([
        ["title", sqlString(intervention.title)],
        ["status", sqlString("suggested")],
        ["strength", sqlString(intervention.strength)],
        ["risk", "NONE"],
        ["expected_effect", sqlOptionString(intervention.expectedEffect)],
        ["review_criteria", sqlJsonOption(intervention.reviewCriteria)],
        ["approval_required", sqlBool(intervention.approvalRequired)],
        ["updated_at", "time::now()"],
    ])};`;
}

function interventionObservationStatement(
    observation: InterventionObservation,
    intervention: InterventionSuggestion | undefined,
    observedAt: string,
): string {
    return `UPSERT ${recordRef("intervention_observation", interventionObservationKey(observation, observedAt))} MERGE ${sqlObject([
        ["intervention", intervention ? recordRef("intervention", interventionKey(intervention)) : "NONE"],
        ["target", sqlString(observation.target)],
        ["status", sqlString(observation.status)],
        ["metrics_before", sqlJsonOption(observation.before)],
        ["metrics_after", sqlJsonOption(observation.after)],
        ["metrics", sqlJsonOption(observation.metrics)],
        ["notes", sqlJsonOption(observation.notes)],
        ["observed_at", sqlDate(observedAt)],
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

export const ingestHarness = (): Effect.Effect<HarnessIngestStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const report = yield* buildProjectHarnessReport();
        const statements = buildHarnessIngestStatements(report);
        for (let i = 0; i < statements.length; i += 250) {
            yield* db.query(statements.slice(i, i + 250).join(""));
        }
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
