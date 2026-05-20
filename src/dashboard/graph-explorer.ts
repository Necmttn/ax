import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import type {
    GraphExplorerEdge,
    GraphExplorerMode,
    GraphExplorerNode,
    GraphExplorerPanel,
    GraphExplorerPayload,
    GraphExplorerStoryCard,
    GraphMetricValue,
    GraphNodeKind,
} from "../lib/shared/dashboard-types.ts";

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
// reads them via a single per-row `session_health` subquery instead of the
// ~5 correlated scans over the 400k-row `turn` table that hung the endpoint
// (GitHub issue #77). The `task_label` derivation - the two-tier organic-task
// fallback with boilerplate filtering - now lives in
// `src/lib/shared/task-label.ts` (consumed by the ingest derivation).
export const FILE_ATTENTION_SQL = `
SELECT
    <string>session AS source_id,
    (
        (SELECT task_label FROM session_health WHERE session = $parent.session LIMIT 1)[0].task_label
        ??
        session.project
        ??
        <string>session
    ) AS source_label,
    "session" AS source_kind,
    (session.project ?? session.cwd ?? session.source ?? NONE) AS source_subtitle,
    <string>file AS target_id,
    file.path AS target_label,
    "file" AS target_kind,
    (file.lang ?? file.kind ?? NONE) AS target_subtitle,
    "edited" AS relation,
    weight,
    last_seen,
    session.started_at AS source_started_at,
    session.ended_at AS source_ended_at,
    ((SELECT user_turns FROM session_health WHERE session = $parent.session LIMIT 1)[0].user_turns ?? 0) AS source_user_turns,
    ((SELECT assistant_turns FROM session_health WHERE session = $parent.session LIMIT 1)[0].assistant_turns ?? 0) AS source_assistant_turns,
    ((SELECT correction_turns FROM session_health WHERE session = $parent.session LIMIT 1)[0].correction_turns ?? 0) AS source_corrections,
    ((SELECT interruptions FROM session_health WHERE session = $parent.session LIMIT 1)[0].interruptions ?? 0) AS source_interruptions,
    ((SELECT math::sum(duration_ms) AS total, session FROM phase_span WHERE session = $parent.session AND user_turns = 0 GROUP BY session)[0].total ?? NONE) AS source_hands_free_ms,
    array::len((SELECT id FROM produced WHERE in = $parent.session)) AS source_produced_commits,
    ((SELECT status FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].status ?? NONE) AS source_delivery_status,
    ((SELECT review_pain FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].review_pain ?? NONE) AS source_review_pain,
    ((SELECT pr_size FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].pr_size ?? NONE) AS source_pr_size,
    ((SELECT pull_request.title AS pr_title FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].pr_title ?? NONE) AS source_pr_title
FROM (
    SELECT
        in.session AS session,
        out AS file,
        count() AS weight,
        time::max(ts) AS last_seen
    FROM edited
    WHERE out.path IS NOT NONE
      AND ($q = "" OR string::lowercase(out.path) CONTAINS $q OR string::lowercase(in.session.project ?? "") CONTAINS $q)
    GROUP BY session, file
)
ORDER BY weight DESC, last_seen DESC
LIMIT $limit;`;

export function validateFileAttentionSql(sql = FILE_ATTENTION_SQL): ReadonlyArray<string> {
    const warnings: string[] = [];
    if (!sql.includes("$q")) warnings.push("missing parameterized q binding");
    if (!sql.includes("$limit")) warnings.push("missing parameterized limit binding");
    if (/GROUP\s+BY\s+[^;\n]*\bin\.session\b/i.test(sql)) {
        warnings.push("groups by dereferenced in.session expression");
    }
    if (/math::max\s*\(\s*ts\s*\)/i.test(sql)) {
        warnings.push("uses math::max for datetime aggregation");
    }
    if (!/time::max\s*\(\s*ts\s*\)/i.test(sql)) {
        warnings.push("missing datetime-friendly time::max aggregation");
    }
    if (!/FROM\s*\(\s*SELECT[\s\S]*GROUP\s+BY\s+session\s*,\s*file[\s\S]*\)/i.test(sql)) {
        warnings.push("missing aggregate subquery grouped by session and file aliases");
    }
    if (/FROM\s+turn/i.test(sql)) {
        warnings.push("per-row turn-table scan reintroduced; read precomputed session_health metrics");
    }
    if (!/session_health[\s\S]*task_label/i.test(sql)) {
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
): Effect.Effect<GraphExplorerPayload, DbError, SurrealClient> =>
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

        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            FILE_ATTENTION_SQL,
            { q: query?.toLowerCase() ?? "", limit },
        );

        return rowsToGraphPayload({
            mode: modeResolution.effectiveMode,
            query,
            rows: rows?.[0] ?? [],
            warnings: modeResolution.warnings,
        });
    });
