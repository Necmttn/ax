import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { CacheRead } from "@ax/lib/duckdb/seam";

export interface SidecarArtifactSummaryRow {
    readonly kind: string;
    readonly artifacts: number;
}

export interface SidecarUsageSummaryRow {
    readonly action: string;
    readonly sidecar_kind: string;
    readonly edges: number;
}

export interface SidecarUsageSummary {
    readonly artifacts: readonly SidecarArtifactSummaryRow[];
    readonly usage: readonly SidecarUsageSummaryRow[];
}

export const SIDECAR_ARTIFACT_SUMMARY_SQL = `
SELECT kind, count(*) AS artifacts
FROM claude_sidecar_artifact
GROUP BY kind
ORDER BY artifacts DESC`;

export const SIDECAR_EDGE_SUMMARY_SQL = `
SELECT action, sidecar_kind, count(*) AS edges
FROM used_sidecar_artifact
GROUP BY action, sidecar_kind
ORDER BY edges DESC`;

/** @deprecated Use the two single-statement constants above. */
export const SIDECAR_USAGE_SUMMARY_SQL = `${SIDECAR_ARTIFACT_SUMMARY_SQL};\n${SIDECAR_EDGE_SUMMARY_SQL};`;

const SidecarArtifactRow = Schema.Struct({
    kind: Schema.String,
    artifacts: NumberFromBigIntColumn,
});

const SidecarUsageRow = Schema.Struct({
    action: Schema.String,
    sidecar_kind: Schema.String,
    edges: NumberFromBigIntColumn,
});

export const fetchSidecarUsageSummary = Effect.fn("queries.fetchSidecarUsageSummary")(function* () {
    const cache = yield* CacheRead;
    const [artifacts, usage] = yield* Effect.all([
        cache.rows(SidecarArtifactRow, SIDECAR_ARTIFACT_SUMMARY_SQL),
        cache.rows(SidecarUsageRow, SIDECAR_EDGE_SUMMARY_SQL),
    ]);

    return {
        artifacts,
        usage,
    } satisfies SidecarUsageSummary;
});
