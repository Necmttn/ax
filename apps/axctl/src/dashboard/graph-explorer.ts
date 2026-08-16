import { Effect } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import type {
    GraphExplorerEdge,
    GraphExplorerMode,
    GraphExplorerNode,
    GraphExplorerPanel,
    GraphExplorerPayload,
    GraphExplorerStoryCard,
    GraphMetricValue,
    GraphNodeKind,
} from "@ax/lib/shared/dashboard-types";

const DEFAULT_MODE: GraphExplorerMode = "file-attention";
const GRAPH_MODES = new Set<GraphExplorerMode>([
    "skill-pairs",
    "file-attention",
    "ask-outcome",
    "phase-balance",
    "delivery",
    "patterns",
]);
const IMPLEMENTED_MODES = new Set<GraphExplorerMode>([DEFAULT_MODE]);
const NODE_KINDS = new Set<GraphNodeKind>([
    "skill",
    "file",
    "session",
    "message",
    "commit",
    "pull_request",
    "pattern",
    "phase",
]);

// The five turn-derived metrics (task_label, user/assistant/correction turn
// counts) plus interruptions are precomputed once per session during the
// `session-health` ingest stage and stored on `session_health`. This query
// LEFT JOINs `session_health`/`delivery_outcome`/`pull_request` (each UNIQUE
// on session, so the join adds at most one row) instead of the ~5 correlated
// scans over the 400k-row `turn` table that hung the endpoint (GitHub issue
// #77) - the DuckDB translation goes a step further than the original
// SurrealQL's per-row scalar subqueries against session_health/delivery_outcome,
// collapsing those into 2 real JOINs (only phase_span's SUM and produced's
// COUNT stay as scalar subqueries, since neither is unique-per-session). The
// `task_label` derivation - the two-tier organic-task fallback with
// boilerplate filtering - lives in `src/lib/shared/task-label.ts` (consumed
// by the ingest derivation, unaffected by this port).
export const FILE_ATTENTION_SQL = `
SELECT
    agg.session AS source_id,
    COALESCE(h.task_label, s.project, agg.session) AS source_label,
    'session' AS source_kind,
    COALESCE(s.project, s.cwd, s.source) AS source_subtitle,
    agg.file AS target_id,
    f.path AS target_label,
    'file' AS target_kind,
    COALESCE(f.lang, f.kind) AS target_subtitle,
    'edited' AS relation,
    agg.weight AS weight,
    agg.last_seen AS last_seen,
    s.started_at AS source_started_at,
    s.ended_at AS source_ended_at,
    COALESCE(h.user_turns, 0) AS source_user_turns,
    COALESCE(h.assistant_turns, 0) AS source_assistant_turns,
    COALESCE(h.correction_turns, 0) AS source_corrections,
    COALESCE(h.interruptions, 0) AS source_interruptions,
    (SELECT SUM(ps.duration_ms) FROM phase_span ps WHERE ps.session = agg.session AND ps.user_turns = 0) AS source_hands_free_ms,
    (SELECT count(*) FROM produced pd WHERE pd.in_id = agg.session) AS source_produced_commits,
    d.status AS source_delivery_status,
    d.review_pain AS source_review_pain,
    d.pr_size AS source_pr_size,
    pr.title AS source_pr_title
FROM (
    SELECT
        t.session AS session,
        e.out_id AS file,
        count(*) AS weight,
        MAX(e.ts) AS last_seen
    FROM edited e
    JOIN turn t ON t.id = e.in_id
    JOIN file f2 ON f2.id = e.out_id
    LEFT JOIN session s2 ON s2.id = t.session
    WHERE f2.path IS NOT NULL
      AND (? = '' OR lower(f2.path) LIKE '%' || ? || '%' OR lower(COALESCE(s2.project, '')) LIKE '%' || ? || '%')
    GROUP BY t.session, e.out_id
) agg
LEFT JOIN session s ON s.id = agg.session
LEFT JOIN file f ON f.id = agg.file
LEFT JOIN session_health h ON h.session = agg.session
LEFT JOIN delivery_outcome d ON d.session = agg.session
LEFT JOIN pull_request pr ON pr.id = d.pull_request
ORDER BY agg.weight DESC, agg.last_seen DESC
LIMIT ?;`;

export function validateFileAttentionSql(sql = FILE_ATTENTION_SQL): ReadonlyArray<string> {
    const warnings: string[] = [];
    if ((sql.match(/\?/g) ?? []).length < 4) {
        warnings.push("missing the 3 lowercase-filter bindings + 1 limit binding");
    }
    if (!/GROUP\s+BY\s+t\.session\s*,\s*e\.out_id/i.test(sql)) {
        warnings.push("missing aggregate subquery grouped by session and file");
    }
    // issue #77: turn-derived metrics are precomputed on session_health - the
    // ONLY reference to the turn table must be the single JOIN inside the
    // aggregate subquery, never a second/outer-row scan.
    const turnRefs = (sql.match(/\bturn\b/gi) ?? []).length;
    if (turnRefs !== 1) {
        warnings.push("turn table must be referenced exactly once (inside the aggregate subquery)");
    }
    if (!/session_health/i.test(sql) || !/task_label/i.test(sql)) {
        warnings.push("missing precomputed task_label decoration from session_health");
    }
    if (!/session_health/i.test(sql) || !/delivery_outcome/i.test(sql) || !/produced/i.test(sql) || !/phase_span/i.test(sql)) {
        warnings.push("missing session story signal decoration");
    }
    return warnings;
}

export interface GraphExplorerParams {
    readonly mode?: unknown;
    readonly q?: string | null;
    readonly limit?: number;
}

export interface RowsToGraphPayloadInput {
    readonly mode?: GraphExplorerMode;
    readonly query?: string | null;
    readonly rows: ReadonlyArray<Record<string, unknown>>;
    readonly generatedAt?: string;
    readonly warnings?: ReadonlyArray<string>;
}

export interface GraphExplorerModeResolution {
    readonly requestedMode: GraphExplorerMode;
    readonly effectiveMode: GraphExplorerMode;
    readonly implemented: boolean;
    readonly warnings: ReadonlyArray<string>;
}

export function normalizeGraphMode(value: unknown): GraphExplorerMode {
    return typeof value === "string" && GRAPH_MODES.has(value as GraphExplorerMode)
        ? value as GraphExplorerMode
        : DEFAULT_MODE;
}

export function resolveGraphExplorerMode(value: unknown): GraphExplorerModeResolution {
    const requestedMode = normalizeGraphMode(value);
    if (IMPLEMENTED_MODES.has(requestedMode)) {
        return { requestedMode, effectiveMode: requestedMode, implemented: true, warnings: [] };
    }
    return {
        requestedMode,
        effectiveMode: requestedMode,
        implemented: false,
        warnings: [`Mode "${requestedMode}" is staged; no graph query is implemented yet.`],
    };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const stringifyField = (row: Record<string, unknown>, key: string): string | null => {
    const value = row[key];
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (value === null || value === undefined) return null;
    const stringified = String(value).trim();
    return stringified.length > 0 && stringified !== "[object Object]" ? stringified : null;
};

const numberField = (row: Record<string, unknown>, key: string): number => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
};

const dateField = (row: Record<string, unknown>, key: string): string | null => {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (value && typeof value === "object" && "toJSON" in value) {
        const json = (value as { toJSON: () => unknown }).toJSON();
        if (typeof json === "string" && json.length > 0) return json;
    }
    return null;
};

const kindField = (row: Record<string, unknown>, key: string): GraphNodeKind | null => {
    const value = stringifyField(row, key);
    return value !== null && NODE_KINDS.has(value as GraphNodeKind)
        ? value as GraphNodeKind
        : null;
};

const metricEntries = (
    row: Record<string, unknown>,
    keys: ReadonlyArray<string>,
): Record<string, GraphMetricValue> | undefined => {
    const metrics: Record<string, GraphMetricValue> = {};
    for (const key of keys) {
        const value = row[key];
        if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            value === null
        ) {
            metrics[key] = value;
        }
    }
    return Object.keys(metrics).length > 0 ? metrics : undefined;
};

const nodeTone = (kind: GraphNodeKind): string => {
    if (kind === "file") return "accent";
    if (kind === "session") return "neutral";
    if (kind === "skill") return "success";
    if (kind === "pattern") return "warning";
    return "muted";
};

const makeNode = (input: {
    readonly id: string;
    readonly label: string;
    readonly kind: GraphNodeKind;
    readonly subtitle: string | null;
    readonly metrics: Record<string, GraphMetricValue> | undefined;
}): GraphExplorerNode => ({
    id: input.id,
    label: input.label,
    kind: input.kind,
    weight: 0,
    tone: nodeTone(input.kind),
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
});

interface StoryAccumulator {
    readonly sessionId: string;
    title: string;
    project: string | null;
    deliveryStatus: string | null;
    reviewPain: string | null;
    prSize: string | null;
    prTitle: string | null;
    producedCommits: number;
    durationMs: number | null;
    handsFreeMs: number | null;
    userTurns: number;
    assistantTurns: number;
    corrections: number;
    interruptions: number;
    edgeWeight: number;
    readonly files: Map<string, { label: string; weight: number }>;
}

const durationBetween = (startedAt: string | null, endedAt: string | null): number | null => {
    if (!startedAt || !endedAt) return null;
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return end - start;
};

const outcomeStatus = (story: StoryAccumulator): string => {
    if (story.deliveryStatus === "merged_to_main" || story.deliveryStatus === "promoted_without_pr") return "shipped";
    if (story.deliveryStatus === "merged_unverified") return "merged";
    if (story.deliveryStatus === "open_pr") return "review_requested";
    if (story.deliveryStatus === "closed_unmerged") return "failed";
    if (story.interruptions > 0) return "interrupted";
    if (story.producedCommits > 0) return "local_commit";
    return "local_only";
};

const whyScore = (story: StoryAccumulator): { score: number; reason: string } => {
    const filesTouched = story.files.size;
    let score = Math.min(60, story.edgeWeight) + filesTouched * 4;
    const reasons: string[] = [`${filesTouched} files`, `${story.edgeWeight} edits`];
    if (story.producedCommits > 0) {
        score += Math.min(30, story.producedCommits * 10);
        reasons.push(`${story.producedCommits} commits`);
    }
    if (story.deliveryStatus === "merged_to_main" || story.deliveryStatus === "promoted_without_pr") {
        score += 30;
        reasons.push("main signal");
    }
    if (story.deliveryStatus === "open_pr") {
        score += 18;
        reasons.push("open PR");
    }
    if (story.reviewPain === "high" || story.reviewPain === "roasted") {
        score += 16;
        reasons.push(`${story.reviewPain} review`);
    }
    if (story.corrections > 0) {
        score += Math.min(20, story.corrections * 5);
        reasons.push(`${story.corrections} corrections`);
    }
    if (story.interruptions > 0) {
        score += Math.min(14, story.interruptions * 4);
        reasons.push(`${story.interruptions} interruptions`);
    }
    return { score: Math.round(score), reason: reasons.join(" / ") };
};

const storyCardsFromRows = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<GraphExplorerStoryCard> => {
    const stories = new Map<string, StoryAccumulator>();

    for (const row of rows) {
        if (!isRecord(row)) continue;
        const sessionId = stringifyField(row, "source_id");
        const targetId = stringifyField(row, "target_id");
        const targetLabel = stringifyField(row, "target_label") ?? targetId;
        const title = stringifyField(row, "source_label") ?? sessionId;
        if (!sessionId || !targetId || !targetLabel || !title) continue;

        const startedAt = dateField(row, "source_started_at");
        const endedAt = dateField(row, "source_ended_at");
        const story = stories.get(sessionId) ?? {
            sessionId,
            title,
            project: stringifyField(row, "source_subtitle"),
            deliveryStatus: stringifyField(row, "source_delivery_status"),
            reviewPain: stringifyField(row, "source_review_pain"),
            prSize: stringifyField(row, "source_pr_size"),
            prTitle: stringifyField(row, "source_pr_title"),
            producedCommits: numberField(row, "source_produced_commits"),
            durationMs: durationBetween(startedAt, endedAt),
            handsFreeMs: numberField(row, "source_hands_free_ms") || null,
            userTurns: numberField(row, "source_user_turns"),
            assistantTurns: numberField(row, "source_assistant_turns"),
            corrections: numberField(row, "source_corrections"),
            interruptions: numberField(row, "source_interruptions"),
            edgeWeight: 0,
            files: new Map<string, { label: string; weight: number }>(),
        };

        story.title = title;
        story.project = story.project ?? stringifyField(row, "source_subtitle");
        story.deliveryStatus = story.deliveryStatus ?? stringifyField(row, "source_delivery_status");
        story.reviewPain = story.reviewPain ?? stringifyField(row, "source_review_pain");
        story.prSize = story.prSize ?? stringifyField(row, "source_pr_size");
        story.prTitle = story.prTitle ?? stringifyField(row, "source_pr_title");
        story.producedCommits = Math.max(story.producedCommits, numberField(row, "source_produced_commits"));
        story.handsFreeMs = Math.max(story.handsFreeMs ?? 0, numberField(row, "source_hands_free_ms")) || null;
        story.userTurns = Math.max(story.userTurns, numberField(row, "source_user_turns"));
        story.assistantTurns = Math.max(story.assistantTurns, numberField(row, "source_assistant_turns"));
        story.corrections = Math.max(story.corrections, numberField(row, "source_corrections"));
        story.interruptions = Math.max(story.interruptions, numberField(row, "source_interruptions"));

        const weight = Math.max(1, numberField(row, "weight"));
        story.edgeWeight += weight;
        const existingFile = story.files.get(targetId);
        story.files.set(targetId, {
            label: targetLabel,
            weight: (existingFile?.weight ?? 0) + weight,
        });
        stories.set(sessionId, story);
    }

    return Array.from(stories.values())
        .map((story) => {
            const why = whyScore(story);
            const deliveryStatus = story.deliveryStatus;
            return {
                session_id: story.sessionId,
                title: story.title,
                project: story.project,
                outcome_status: outcomeStatus(story),
                delivery_status: deliveryStatus,
                review_pain: story.reviewPain,
                pr_size: story.prSize,
                pr_title: story.prTitle,
                files_touched: story.files.size,
                top_files: Array.from(story.files.values())
                    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
                    .slice(0, 4)
                    .map((file) => file.label),
                produced_commits: story.producedCommits,
                merged_to_main: deliveryStatus === "merged_to_main" || deliveryStatus === "promoted_without_pr",
                duration_ms: story.durationMs,
                hands_free_ms: story.handsFreeMs,
                user_turns: story.userTurns,
                assistant_turns: story.assistantTurns,
                corrections: story.corrections,
                interruptions: story.interruptions,
                why_score: why.score,
                why_reason: why.reason,
            };
        })
        .sort((a, b) => b.why_score - a.why_score || b.files_touched - a.files_touched || a.title.localeCompare(b.title))
        .slice(0, 12);
};

export function rowsToGraphPayload(input: RowsToGraphPayloadInput): GraphExplorerPayload {
    const mode = input.mode ?? DEFAULT_MODE;
    const nodes = new Map<string, GraphExplorerNode>();
    const nodeWeights = new Map<string, number>();
    const edges = new Map<string, GraphExplorerEdge>();

    for (const row of input.rows) {
        if (!isRecord(row)) continue;
        const source = stringifyField(row, "source_id");
        const target = stringifyField(row, "target_id");
        const sourceLabel = stringifyField(row, "source_label") ?? source;
        const targetLabel = stringifyField(row, "target_label") ?? target;
        const sourceKind = kindField(row, "source_kind");
        const targetKind = kindField(row, "target_kind");
        const relation = stringifyField(row, "relation") ?? "related";
        if (!source || !target || !sourceKind || !targetKind || !sourceLabel || !targetLabel || source === target) {
            continue;
        }

        const weight = Math.max(1, numberField(row, "weight"));
        const edgeKey = `${source}\u0000${target}\u0000${relation}`;
        const edgeMetrics = metricEntries(row, ["weight", "last_seen", "count", "duration_ms"]);
        const existingEdge = edges.get(edgeKey);
        if (existingEdge) {
            edges.set(edgeKey, {
                ...existingEdge,
                weight: existingEdge.weight + weight,
                metrics: { ...existingEdge.metrics, ...edgeMetrics },
            });
        } else {
            const lastSeen = dateField(row, "last_seen");
            edges.set(edgeKey, {
                source,
                target,
                relation,
                weight,
                tone: relation === "edited" ? "attention" : "neutral",
                label: stringifyField(row, "label") ?? relation,
                metrics: {
                    ...(edgeMetrics ?? {}),
                    ...(lastSeen ? { last_seen: lastSeen } : {}),
                },
            });
        }

        const sourceMetrics = metricEntries(row, ["source_count", "source_score"]);
        const targetMetrics = metricEntries(row, ["target_count", "target_score"]);
        nodes.set(source, makeNode({
            id: source,
            label: sourceLabel,
            kind: sourceKind,
            subtitle: stringifyField(row, "source_subtitle"),
            metrics: sourceMetrics,
        }));
        nodes.set(target, makeNode({
            id: target,
            label: targetLabel,
            kind: targetKind,
            subtitle: stringifyField(row, "target_subtitle"),
            metrics: targetMetrics,
        }));
        nodeWeights.set(source, (nodeWeights.get(source) ?? 0) + weight);
        nodeWeights.set(target, (nodeWeights.get(target) ?? 0) + weight);
    }

    const sortedEdges = Array.from(edges.values()).sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source));
    const sortedNodes = Array.from(nodes.values())
        .map((node) => ({ ...node, weight: nodeWeights.get(node.id) ?? node.weight }))
        .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
    const maxEdge = sortedEdges.reduce((max, edge) => Math.max(max, edge.weight), 0);
    const panels: GraphExplorerPanel[] = [
        {
            title: "Graph Summary",
            kind: "summary",
            rows: [
                { label: "Mode", value: mode },
                { label: "Nodes", value: sortedNodes.length.toLocaleString("en-US") },
                { label: "Edges", value: sortedEdges.length.toLocaleString("en-US") },
                { label: "Max edge weight", value: maxEdge.toLocaleString("en-US") },
            ],
        },
        {
            title: "Evidence",
            kind: "evidence",
            rows: sortedEdges.slice(0, 5).map((edge) => ({
                label: edge.relation,
                value: edge.weight.toLocaleString("en-US"),
                detail: `${nodes.get(edge.source)?.label ?? edge.source} -> ${nodes.get(edge.target)?.label ?? edge.target}`,
            })),
        },
    ];

    return {
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        mode,
        query: input.query ?? null,
        nodes: sortedNodes,
        edges: sortedEdges,
        story_cards: storyCardsFromRows(input.rows),
        panels,
        warnings: input.warnings ?? [],
    };
}

const clampLimit = (limit: number | undefined): number => {
    const value = Math.floor(limit ?? 120);
    if (!Number.isFinite(value)) return 120;
    return Math.max(10, Math.min(500, value));
};

export const fetchGraphExplorer = (
    params: GraphExplorerParams = {},
): Effect.Effect<GraphExplorerPayload, never, CacheRead> =>
    Effect.gen(function* () {
        const modeResolution = resolveGraphExplorerMode(params.mode);
        const query = typeof params.q === "string" && params.q.trim().length > 0
            ? params.q.trim()
            : null;
        const limit = clampLimit(params.limit);

        if (!modeResolution.implemented) {
            return rowsToGraphPayload({
                mode: modeResolution.effectiveMode,
                query,
                rows: [],
                warnings: modeResolution.warnings,
            });
        }

        const read = yield* CacheRead;
        const q = query?.toLowerCase() ?? "";
        const rows = yield* read.raw(FILE_ATTENTION_SQL, [q, q, q, limit]).pipe(
            Effect.map((r) => r.rows as ReadonlyArray<Record<string, unknown>>),
            Effect.catch((err) =>
                Effect.sync(() => {
                    console.error("ax graph-explorer fetchGraphExplorer failed:", err);
                    return [] as ReadonlyArray<Record<string, unknown>>;
                }),
            ),
        );

        return rowsToGraphPayload({
            mode: modeResolution.effectiveMode,
            query,
            rows,
            warnings: modeResolution.warnings,
        });
    });
