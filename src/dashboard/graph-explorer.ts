import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import type {
    GraphExplorerEdge,
    GraphExplorerMode,
    GraphExplorerNode,
    GraphExplorerPanel,
    GraphExplorerPayload,
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

export const FILE_ATTENTION_SQL = `
SELECT
    <string>session AS source_id,
    (
        (SELECT text_excerpt, seq FROM turn
            WHERE session = $parent.session
              AND role = "user"
              AND message_kind = "task"
              AND intent_kind IN ["organic_task", "preference", "correction"]
              AND text_excerpt IS NOT NONE
              AND !(string::lowercase(text_excerpt) CONTAINS "<local-command")
              AND !(string::lowercase(text_excerpt) CONTAINS "base directory for this skill:")
              AND !(string::lowercase(text_excerpt) CONTAINS "base directory for this plugin:")
              AND !(string::lowercase(text_excerpt) CONTAINS "<environment_context>")
              AND !(string::lowercase(text_excerpt) CONTAINS "<instructions>")
              AND !(string::lowercase(text_excerpt) CONTAINS "# agents.md instructions")
              AND !(string::lowercase(text_excerpt) CONTAINS "# claude.md")
              AND !(string::lowercase(text_excerpt) CONTAINS "review all changed files for reuse")
              AND !(string::lowercase(text_excerpt) CONTAINS "session-scoped stop hook")
              AND !(string::lowercase(text_excerpt) CONTAINS "this session is being continued")
            ORDER BY seq ASC
            LIMIT 1
        )[0].text_excerpt
        ??
        (SELECT text_excerpt, seq FROM turn
            WHERE session = $parent.session
              AND role = "user"
              AND message_kind = "task"
              AND text_excerpt IS NOT NONE
              AND !(string::lowercase(text_excerpt) CONTAINS "<local-command")
              AND !(string::lowercase(text_excerpt) CONTAINS "base directory for this skill:")
              AND !(string::lowercase(text_excerpt) CONTAINS "base directory for this plugin:")
              AND !(string::lowercase(text_excerpt) CONTAINS "<environment_context>")
              AND !(string::lowercase(text_excerpt) CONTAINS "<instructions>")
              AND !(string::lowercase(text_excerpt) CONTAINS "# agents.md instructions")
              AND !(string::lowercase(text_excerpt) CONTAINS "# claude.md")
              AND !(string::lowercase(text_excerpt) CONTAINS "review all changed files for reuse")
              AND !(string::lowercase(text_excerpt) CONTAINS "session-scoped stop hook")
              AND !(string::lowercase(text_excerpt) CONTAINS "this session is being continued")
            ORDER BY seq ASC
            LIMIT 1
        )[0].text_excerpt
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
    last_seen
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
    if (!/FROM\s+turn/i.test(sql) || !/text_excerpt/i.test(sql) || !/organic_task/i.test(sql)) {
        warnings.push("missing first-user-ask session decoration");
    }
    if (!/message_kind\s*=\s*"task"/i.test(sql) || !/local-command/i.test(sql)) {
        warnings.push("missing human-task filter for session labels");
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
