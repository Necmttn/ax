import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";

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

export const SIDECAR_USAGE_SUMMARY_SQL = `
SELECT kind, count() AS artifacts
FROM claude_sidecar_artifact
GROUP BY kind
ORDER BY artifacts DESC;

SELECT action, sidecar_kind, count() AS edges
FROM used_sidecar_artifact
GROUP BY action, sidecar_kind
ORDER BY edges DESC;
`;

export const fetchSidecarUsageSummary = Effect.fn("queries.fetchSidecarUsageSummary")(function* () {
    const db = yield* SurrealClient;
    const [artifacts, usage] = yield* db.query<[
        SidecarArtifactSummaryRow[],
        SidecarUsageSummaryRow[],
    ]>(SIDECAR_USAGE_SUMMARY_SQL);

    return {
        artifacts: artifacts ?? [],
        usage: usage ?? [],
    } satisfies SidecarUsageSummary;
});
