import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { ProcessService } from "../lib/process.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { buildProjectHarnessReport } from "../project/harness.ts";
import type {
    GuidanceRevision,
    GuidanceSource,
    ProjectHarnessReport,
    StackSignal,
} from "../project/types.ts";
import { recordRef } from "./evidence-writers.ts";
import { surrealDate, surrealJsonOption, surrealObject, surrealOptionString, surrealString } from "../lib/shared/surql.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";
import { safeKeyPart } from "../lib/shared/derive-keys.ts";

export interface HarnessIngestStats {
    readonly guidanceSources: number;
    readonly guidanceRevisions: number;
    readonly stacks: number;
}

const sqlBool = (value: boolean): string => value ? "true" : "false";


export const guidanceSourceKey = (source: Pick<GuidanceSource, "path">): string =>
    `${safeKeyPart(source.path)}__${Bun.hash(source.path).toString(16).slice(0, 16)}`;

export const guidanceRevisionKey = (revision: Pick<GuidanceRevision, "sourcePath" | "contentHash">): string =>
    `${safeKeyPart(revision.sourcePath).slice(0, 72)}__${revision.contentHash}`;

export const stackKey = (signal: Pick<StackSignal, "name">): string =>
    safeKeyPart(signal.name.toLowerCase());

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

export function buildHarnessIngestStatements(report: ProjectHarnessReport): string[] {
    return [
        ...report.guidanceSources.map(guidanceSourceStatement),
        ...report.guidanceRevisions.map(guidanceRevisionStatement),
        ...report.stacks.map(stackStatement),
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

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { Schema } from "effect";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const HarnessKey = Schema.Literal("harness");
export type HarnessKey = typeof HarnessKey.Type;

/**
 * Harness stage - rolls up Harness Doctor evidence (Guidance sources/revisions,
 * Stack capability). Depends on {@link OutcomesKey}, {@link SessionHealthKey},
 * {@link ClosureKey}.
 */
export class HarnessStageStats extends BaseStageStats.extend<HarnessStageStats>("HarnessStageStats")({
    guidanceSources: Schema.Number,
    guidanceRevisions: Schema.Number,
    stacks: Schema.Number,
}) {}

export const harnessStage: StageDef<HarnessStageStats, SurrealClient | ProcessService> = {
    meta: StageMeta.make({ key: "harness", deps: ["outcomes", "session-health", "closure"], tags: ["derive", "health"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* ingestHarness();
            return HarnessStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.guidanceSources} guidance sources, ${result.guidanceRevisions} revisions, ${result.stacks} stacks`,
                guidanceSources: result.guidanceSources,
                guidanceRevisions: result.guidanceRevisions,
                stacks: result.stacks,
            });
        }),
};
