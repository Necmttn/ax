import { Effect, FileSystem, Path } from "effect";
import { ProcessService } from "@ax/lib/process";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
import { buildProjectHarnessReport } from "../project/harness.ts";
import type { GuidanceRevision, GuidanceSource, StackSignal } from "../project/types.ts";

export interface HarnessIngestStats {
    readonly guidanceSources: number;
    readonly guidanceRevisions: number;
    readonly stacks: number;
}

export const guidanceSourceKey = (source: Pick<GuidanceSource, "path">): string =>
    stableId("guidance_source", [source.path]);

export const guidanceRevisionKey = (revision: Pick<GuidanceRevision, "sourcePath" | "contentHash">): string =>
    stableId("guidance_revision", [revision.sourcePath, revision.contentHash]);

export const stackKey = (signal: Pick<StackSignal, "name">): string =>
    stableId("stack", [signal.name.toLowerCase()]);

/**
 * The three collections this stage persists - and the ONLY thing it reads from
 * the harness module. `HarnessGrounding` is deliberately narrower than the full
 * report: the report's other half comes from the published DuckDB snapshot.
 * This stage writes the live cache. A snapshot read would omit current writes.
 */
export function buildHarnessIngestRows(
    report: Pick<import("../project/types.ts").ProjectHarnessReport, "guidanceSources" | "guidanceRevisions" | "stacks">,
){
    return {
        guidanceSources: report.guidanceSources.map((source) => cacheRow({
            id: guidanceSourceKey(source), path: source.path, kind: source.kind, scope: source.scope,
            provider: source.provider, evidence_strength: source.evidenceStrength, git_root: source.gitRoot,
            tracked: source.tracked, observed_at: new Date(),
        })),
        guidanceRevisions: report.guidanceRevisions.map((revision) => cacheRow({
            id: guidanceRevisionKey(revision), source: guidanceSourceKey({ path: revision.sourcePath }),
            source_path: revision.sourcePath, scope: revision.scope, content_hash: revision.contentHash,
            prev_hash: null, bytes: null, prev_bytes: null, change: null,
            evidence_strength: revision.evidenceStrength, commit_evidence: revision.commitEvidence,
            file_evidence: revision.fileEvidence, observed_at: tsParam(revision.observedAt),
        })),
        stacks: report.stacks.map((signal) => cacheRow({
            id: stackKey(signal), name: signal.name, aliases: null,
            labels: jsonParam({ confidence: signal.confidence, evidence: signal.evidence }),
            created_at: new Date(), updated_at: new Date(),
        })),
    };
}

export const ingestHarness = (write: CacheWriteService): Effect.Effect<HarnessIngestStats, CacheWriteError | CacheReadError, ProcessService | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const report = yield* buildProjectHarnessReport(write);
        const rows = buildHarnessIngestRows(report);
        yield* write.putMany("guidance_source", rows.guidanceSources);
        yield* write.putMany("guidance_revision", rows.guidanceRevisions);
        yield* write.putMany("stack", rows.stacks);
        return {
            guidanceSources: report.guidanceSources.length,
            guidanceRevisions: report.guidanceRevisions.length,
            stacks: report.stacks.length,
        };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { Schema } from "effect";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { IngestStageError, StageDef } from "./stage/registry.ts";

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

export const harnessStage: StageDef<HarnessStageStats, ProcessService | FileSystem.FileSystem | Path.Path, IngestStageError> = {
    meta: StageMeta.make({
        key: "harness",
        // Tagged derive/health for pipeline placement, but its writes are
        // parses: guidance/stack rows restate observed on-disk config (#893).
        deps: ["outcomes", "session-health", "closure"],
        tags: ["derive", "health"],
        writes: [
            { table: "guidance_source", mode: "parse" },
            { table: "guidance_revision", mode: "parse" },
            { table: "stack", mode: "parse" },
        ],
    }),
    run: (_ctx: IngestContext, write: CacheWriteService) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* ingestHarness(write);
            return HarnessStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.guidanceSources} guidance sources, ${result.guidanceRevisions} revisions, ${result.stacks} stacks`,
                guidanceSources: result.guidanceSources,
                guidanceRevisions: result.guidanceRevisions,
                stacks: result.stacks,
            });
        }),
};
