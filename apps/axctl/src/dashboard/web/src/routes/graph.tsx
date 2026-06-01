import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "../api.ts";
import type {
    GraphExplorerEdge,
    GraphExplorerMode,
    GraphExplorerNode,
    GraphExplorerPayload,
    GraphExplorerStoryCard,
    GraphMetricValue,
} from "@shared/dashboard-types.ts";

const MODES: ReadonlyArray<{ mode: GraphExplorerMode; label: string; implemented: boolean }> = [
    { mode: "file-attention", label: "File attention", implemented: true },
    { mode: "ask-outcome", label: "Ask -> Outcome", implemented: false },
    { mode: "phase-balance", label: "Phase balance", implemented: false },
    { mode: "delivery", label: "Delivery", implemented: false },
    { mode: "patterns", label: "Patterns", implemented: false },
    { mode: "skill-pairs", label: "Skill pairs", implemented: false },
];

interface LaidOutNode extends GraphExplorerNode {
    x: number;
    y: number;
}

const toneClass = (tone: string): string =>
    tone.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();

const formatMetric = (value: GraphMetricValue): string => {
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2);
    return value;
};

const formatDuration = (ms: number | null): string => {
    if (ms === null || !Number.isFinite(ms)) return "unknown";
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
};

const storyOutcomeLabel = (story: GraphExplorerStoryCard): string => {
    if (story.outcome_status === "shipped") return "shipped";
    if (story.outcome_status === "review_requested") return "review";
    if (story.outcome_status === "failed") return "failed";
    if (story.outcome_status === "interrupted") return "interrupted";
    if (story.outcome_status === "local_commit") return "committed";
    return story.outcome_status.replace(/_/g, " ");
};

const edgeKey = (edge: GraphExplorerEdge, index: number): string =>
    `${edge.source}-${edge.relation}-${edge.target}-${index}`;

function layout(payload: GraphExplorerPayload, width: number, height: number): LaidOutNode[] {
    const nodes: LaidOutNode[] = payload.nodes.map((node, index) => {
        const angle = (index / Math.max(payload.nodes.length, 1)) * Math.PI * 2;
        const radius = Math.min(width, height) * 0.34;
        return {
            ...node,
            x: width / 2 + Math.cos(angle) * radius,
            y: height / 2 + Math.sin(angle) * radius,
        };
    });
    if (nodes.length === 0) return nodes;
    if (nodes.length === 1) {
        nodes[0]!.x = width / 2;
        nodes[0]!.y = height / 2;
        return nodes;
    }

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = payload.edges
        .map((edge) => ({
            source: byId.get(edge.source),
            target: byId.get(edge.target),
            weight: edge.weight,
        }))
        .filter((edge): edge is { source: LaidOutNode; target: LaidOutNode; weight: number } =>
            !!edge.source && !!edge.target,
        );

    const area = width * height;
    const k = Math.sqrt(area / nodes.length) * 0.72;
    const maxWeight = Math.max(1, ...payload.edges.map((edge) => edge.weight));
    let temperature = Math.min(width, height) / 9;

    for (let iteration = 0; iteration < 76; iteration++) {
        const displacements = new Map<LaidOutNode, { dx: number; dy: number }>();
        for (const node of nodes) displacements.set(node, { dx: 0, dy: 0 });

        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i]!;
                const b = nodes[j]!;
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                const distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
                if (distance > k * 4.5) continue;
                const force = (k * k) / distance;
                dx = (dx / distance) * force;
                dy = (dy / distance) * force;
                const ad = displacements.get(a)!;
                const bd = displacements.get(b)!;
                ad.dx += dx;
                ad.dy += dy;
                bd.dx -= dx;
                bd.dy -= dy;
            }
        }

        for (const edge of edges) {
            const dx = edge.source.x - edge.target.x;
            const dy = edge.source.y - edge.target.y;
            const distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const force = ((distance * distance) / k) * (0.45 + edge.weight / maxWeight);
            const ux = (dx / distance) * force;
            const uy = (dy / distance) * force;
            const sd = displacements.get(edge.source)!;
            const td = displacements.get(edge.target)!;
            sd.dx -= ux;
            sd.dy -= uy;
            td.dx += ux;
            td.dy += uy;
        }

        for (const node of nodes) {
            const displacement = displacements.get(node)!;
            const length = Math.sqrt(displacement.dx * displacement.dx + displacement.dy * displacement.dy) || 0.01;
            node.x += (displacement.dx / length) * Math.min(length, temperature);
            node.y += (displacement.dy / length) * Math.min(length, temperature);
            node.x = Math.max(32, Math.min(width - 32, node.x));
            node.y = Math.max(32, Math.min(height - 32, node.y));
        }
        temperature *= 0.95;
    }

    return nodes;
}

const radiusFor = (weight: number, maxWeight: number): number =>
    6 + (weight / Math.max(maxWeight, 1)) * 13;

const LABEL_GAP = 7;
const LABEL_EDGE_PADDING = 12;
const LABEL_CHAR_WIDTH = 6.4;
const DEFAULT_LIMIT = 80;
const DEFAULT_PROMINENT_SESSION_LABELS = 6;
const DEFAULT_PROMINENT_FILE_LABELS = 4;

const truncateLabel = (label: string, availableWidth: number): string => {
    const maxChars = Math.floor(Math.max(0, availableWidth) / LABEL_CHAR_WIDTH);
    if (label.length <= maxChars) return label;
    if (maxChars <= 0) return "";
    if (maxChars <= 3) return ".".repeat(maxChars);
    return `${label.slice(0, maxChars - 3)}...`;
};

const labelPlacement = (
    node: LaidOutNode,
    radius: number,
    width: number,
): { displayLabel: string; x: number; textAnchor: "start" | "end" } => {
    const estimatedLabelWidth = node.label.length * LABEL_CHAR_WIDTH;
    const rightSpace = Math.max(0, width - node.x - radius - LABEL_GAP - LABEL_EDGE_PADDING);
    const leftSpace = Math.max(0, node.x - radius - LABEL_GAP - LABEL_EDGE_PADDING);
    const placeLeft = rightSpace < estimatedLabelWidth && leftSpace > rightSpace;
    const availableWidth = placeLeft ? leftSpace : rightSpace;
    return {
        displayLabel: truncateLabel(node.label, availableWidth),
        x: placeLeft ? -(radius + LABEL_GAP) : radius + LABEL_GAP,
        textAnchor: placeLeft ? "end" : "start",
    };
};

export function GraphRoute() {
    const navigate = useNavigate({ from: "/graph" });
    const search = useSearch({ from: "/graph" });
    const mode = search.mode ?? "file-attention";
    const activeMode = MODES.find((item) => item.mode === mode) ?? MODES[0]!;
    const stagedMode = !activeMode.implemented;
    const activeQ = (search.q ?? "").trim();
    const limit = search.limit ?? DEFAULT_LIMIT;
    const [q, setQ] = useState(activeQ);
    const [showAllLabels, setShowAllLabels] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const ref = useRef<HTMLDivElement | null>(null);
    const [box, setBox] = useState({ w: 820, h: 600 });

    useEffect(() => {
        setQ(activeQ);
    }, [activeQ]);

    useEffect(() => {
        if (!ref.current) return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setBox({
                    w: Math.max(280, Math.floor(entry.contentRect.width)),
                    h: Math.max(420, Math.floor(entry.contentRect.height)),
                });
            }
        });
        observer.observe(ref.current);
        return () => observer.disconnect();
    }, []);

    const query = useQuery({
        queryKey: ["graph-explorer", mode, activeQ, limit],
        queryFn: () => api.graphExplorer({ mode, q: activeQ || null, limit }),
        enabled: !stagedMode,
    });
    const data = query.data ?? null;
    const loading = !stagedMode && (query.isLoading || query.isFetching);
    const error = !stagedMode && query.error ? String(query.error) : null;

    useEffect(() => {
        if (!data) return;
        if (selectedId && data.nodes.some((node) => node.id === selectedId)) return;
        setSelectedId(data.nodes.find((node) => node.kind === "session")?.id ?? data.nodes[0]?.id ?? null);
    }, [data, selectedId]);

    const laidOut = useMemo(() => data ? layout(data, box.w, box.h) : [], [data, box.w, box.h]);
    const positions = useMemo(() => new Map(laidOut.map((node) => [node.id, node])), [laidOut]);
    const maxNodeWeight = useMemo(
        () => laidOut.reduce((max, node) => Math.max(max, node.weight), 0),
        [laidOut],
    );
    const maxEdgeWeight = useMemo(
        () => Math.max(1, ...(data?.edges.map((edge) => edge.weight) ?? [1])),
        [data],
    );
    const selected = selectedId ? positions.get(selectedId) ?? data?.nodes.find((node) => node.id === selectedId) ?? null : null;
    const nodeLabels = useMemo(
        () => new Map((data?.nodes ?? []).map((node) => [node.id, node.label])),
        [data],
    );
    const storyBySessionId = useMemo(
        () => new Map((data?.story_cards ?? []).map((story) => [story.session_id, story])),
        [data],
    );
    const connectedIds = useMemo(() => {
        if (!selectedId || !data) return new Set<string>();
        const ids = new Set<string>([selectedId]);
        for (const edge of data.edges) {
            if (edge.source === selectedId) ids.add(edge.target);
            if (edge.target === selectedId) ids.add(edge.source);
        }
        return ids;
    }, [data, selectedId]);
    const selectedEdges = useMemo(() => {
        if (!selectedId || !data) return [];
        return data.edges
            .filter((edge) => edge.source === selectedId || edge.target === selectedId)
            .slice()
            .sort((a, b) => b.weight - a.weight);
    }, [data, selectedId]);
    const selectedConnectionTitle = selected?.kind === "session"
        ? "Files Touched"
        : selected?.kind === "file"
            ? "Sessions"
            : "Connections";
    const prominentLabelIds = useMemo(() => {
        const byWeight = (a: LaidOutNode, b: LaidOutNode) => b.weight - a.weight;
        const sessions = laidOut
            .filter((node) => node.kind === "session")
            .sort(byWeight)
            .slice(0, DEFAULT_PROMINENT_SESSION_LABELS);
        const files = laidOut
            .filter((node) => node.kind === "file")
            .sort(byWeight)
            .slice(0, DEFAULT_PROMINENT_FILE_LABELS);
        return new Set(
            [...sessions, ...files]
                .slice()
                .map((node) => node.id),
        );
    }, [laidOut]);

    const submit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (stagedMode) return;
        void navigate({
            search: {
                mode,
                q: q.trim() || undefined,
                limit,
            },
        });
    };

    const selectMode = (nextMode: GraphExplorerMode) => {
        void navigate({
            search: {
                mode: nextMode,
                q: activeQ || undefined,
                limit,
            },
        });
    };

    const selectLimit = (nextLimit: number) => {
        void navigate({
            search: {
                mode,
                q: activeQ || undefined,
                limit: nextLimit === DEFAULT_LIMIT ? undefined : nextLimit,
            },
        });
    };

    return (
        <section className="panel graph-explorer">
            <header>
                <h2>Graph explorer</h2>
                <span className="meta">
                    {data
                        ? `${data.nodes.length.toLocaleString("en-US")} nodes / ${data.edges.length.toLocaleString("en-US")} edges`
                        : "Typed graph inspection"}
                </span>
            </header>

            <div className="graph-shell">
                <aside className="graph-left-rail" aria-label="Graph modes">
                    <div className="graph-rail-title">Mode</div>
                    <div className="graph-mode-list">
                        {MODES.map((item) => (
                            <button
                                key={item.mode}
                                type="button"
                                className={[
                                    item.mode === mode ? "is-active" : "",
                                    item.implemented ? "" : "is-staged",
                                ].filter(Boolean).join(" ") || undefined}
                                disabled={!item.implemented}
                                title={item.implemented ? item.label : `${item.label} is staged`}
                                onClick={() => item.implemented ? selectMode(item.mode) : undefined}
                            >
                                <span>{item.label}</span>
                                {!item.implemented ? <small>Staged</small> : null}
                            </button>
                        ))}
                    </div>
                    <form className="graph-query" onSubmit={submit}>
                        <label htmlFor="graph-q">Query</label>
                        <input
                            id="graph-q"
                            type="search"
                            value={q}
                            placeholder="filter files or projects"
                            disabled={stagedMode}
                            onChange={(event) => setQ(event.target.value)}
                        />
                        <button type="submit" disabled={stagedMode}>Apply</button>
                    </form>
                    <div className="graph-display-options">
                        <label htmlFor="graph-limit">Result limit</label>
                        <select
                            id="graph-limit"
                            value={limit}
                            disabled={stagedMode}
                            onChange={(event) => selectLimit(Number(event.target.value))}
                        >
                            <option value={40}>40 edges</option>
                            <option value={80}>80 edges</option>
                            <option value={160}>160 edges</option>
                            <option value={320}>320 edges</option>
                        </select>
                        <label className="graph-check">
                            <input
                                type="checkbox"
                                checked={showAllLabels}
                                disabled={stagedMode}
                                onChange={(event) => setShowAllLabels(event.target.checked)}
                            />
                            Show all labels
                        </label>
                        <p>Session nodes are labeled by the first user ask when transcripts have one.</p>
                        <p>Edges mean that session edited that file; weight is repeated edit evidence.</p>
                    </div>
                </aside>

                <div className="graph-main-column">
                    {data?.story_cards.length ? (
                        <section className="graph-story-strip" aria-label="Session stories">
                            <header>
                                <h3>Session Stories</h3>
                                <span>{data.story_cards.length.toLocaleString("en-US")} ranked</span>
                            </header>
                            <div className="graph-story-list">
                                {data.story_cards.slice(0, 6).map((story) => (
                                    <button
                                        key={story.session_id}
                                        type="button"
                                        className={story.session_id === selectedId ? "is-active" : undefined}
                                        onClick={() => setSelectedId(story.session_id)}
                                    >
                                        <span className="graph-story-score">{story.why_score}</span>
                                        <strong>{story.title}</strong>
                                        <small>{story.project ?? "unknown project"}</small>
                                        <div className="graph-story-tags">
                                            <span>{storyOutcomeLabel(story)}</span>
                                            <span>{story.files_touched} files</span>
                                            <span>{story.produced_commits} commits</span>
                                            <span>{story.user_turns}u / {story.assistant_turns}a</span>
                                            <span>{formatDuration(story.duration_ms)}</span>
                                            {story.hands_free_ms !== null ? <span>{formatDuration(story.hands_free_ms)} hands-free</span> : null}
                                            {story.merged_to_main ? <span>main</span> : null}
                                            {story.pr_size ? <span>{story.pr_size} PR</span> : null}
                                            {story.review_pain ? <span>{story.review_pain} review</span> : null}
                                            {story.corrections > 0 ? <span>{story.corrections} corrections</span> : null}
                                        </div>
                                        <p>{story.pr_title ?? story.why_reason}</p>
                                    </button>
                                ))}
                            </div>
                        </section>
                    ) : null}

                    <div className="graph-stage" ref={ref}>
                        {stagedMode ? (
                            <div className="empty">
                                {activeMode.label} is staged. File attention is the implemented graph mode.
                            </div>
                        ) : null}
                        {error ? <div className="error">Error: {error}</div> : null}
                        {loading && !data ? <div className="loading">Loading graph...</div> : null}
                        {data?.warnings.length ? (
                            <div className="graph-warnings">
                                {data.warnings.map((warning) => (
                                    <span key={warning}>{warning}</span>
                                ))}
                            </div>
                        ) : null}
                        {data && data.nodes.length === 0 ? (
                            <div className="empty">No graph data for this mode and query.</div>
                        ) : null}
                        <svg
                            className="graph-svg"
                            width="100%"
                            height={box.h}
                            viewBox={`0 0 ${box.w} ${box.h}`}
                            role="img"
                            aria-label="Graph explorer canvas"
                        >
                            <g>
                                {data?.edges.map((edge, index) => {
                                    const source = positions.get(edge.source);
                                    const target = positions.get(edge.target);
                                    if (!source || !target) return null;
                                    const active =
                                        selectedId === null ||
                                        edge.source === selectedId ||
                                        edge.target === selectedId ||
                                        edge.source === hoveredId ||
                                        edge.target === hoveredId;
                                    return (
                                        <line
                                            key={edgeKey(edge, index)}
                                            x1={source.x}
                                            y1={source.y}
                                            x2={target.x}
                                            y2={target.y}
                                            className={`graph-edge tone-${toneClass(edge.tone)}`}
                                            strokeDasharray={edge.dashed ? "5 5" : undefined}
                                            strokeWidth={Math.max(1, (edge.weight / maxEdgeWeight) * 4)}
                                            opacity={active ? 0.72 : 0.18}
                                        />
                                    );
                                })}
                                {laidOut.map((node) => {
                                    const radius = radiusFor(node.weight, maxNodeWeight);
                                    const label = labelPlacement(node, radius, box.w);
                                    const selectedNode = node.id === selectedId;
                                    const hoveredNode = node.id === hoveredId;
                                    const showLabel =
                                        showAllLabels ||
                                        selectedNode ||
                                        hoveredNode ||
                                        prominentLabelIds.has(node.id);
                                    const related = connectedIds.size === 0 || connectedIds.has(node.id);
                                    return (
                                        <g
                                            key={node.id}
                                            transform={`translate(${node.x}, ${node.y})`}
                                            className={`graph-node ${selectedNode ? "is-selected" : ""}`}
                                            opacity={related ? 1 : 0.34}
                                            onMouseEnter={() => setHoveredId(node.id)}
                                            onMouseLeave={() => setHoveredId((current) => current === node.id ? null : current)}
                                            onClick={() => setSelectedId(node.id)}
                                        >
                                            <title>{node.label}</title>
                                            <circle
                                                r={radius}
                                                className={`tone-${toneClass(node.tone)} kind-${node.kind}`}
                                            />
                                            {showLabel ? (
                                                <text x={label.x} y={4} textAnchor={label.textAnchor}>
                                                    {label.displayLabel}
                                                </text>
                                            ) : null}
                                        </g>
                                    );
                                })}
                            </g>
                        </svg>
                    </div>
                </div>

                <aside className="graph-inspector">
                    <div className="graph-inspector-section">
                        <h3>Selected</h3>
                        {selected ? (
                            <>
                                <div className="graph-selected-title">{selected.label}</div>
                                <div className="graph-selected-meta">
                                    <span>{selected.kind}</span>
                                    <span>weight {selected.weight.toLocaleString("en-US")}</span>
                                </div>
                                {selected.subtitle ? <p>{selected.subtitle}</p> : null}
                                {selected.metrics ? (
                                    <dl className="graph-metrics">
                                        {Object.entries(selected.metrics).map(([key, value]) => (
                                            <div key={key}>
                                                <dt>{key}</dt>
                                                <dd>{formatMetric(value)}</dd>
                                            </div>
                                        ))}
                                    </dl>
                                ) : null}
                            </>
                        ) : (
                            <p className="workflow-help">Select a node to inspect it.</p>
                        )}
                    </div>

                    {selected ? (
                        <div className="graph-inspector-section">
                            <h3>{selectedConnectionTitle}</h3>
                            {selectedEdges.length === 0 ? (
                                <p className="workflow-help">No connected edges.</p>
                            ) : (
                                <dl className="graph-panel-rows">
                                    {selectedEdges.slice(0, 12).map((edge, index) => {
                                        const otherId = edge.source === selected.id ? edge.target : edge.source;
                                        const story = storyBySessionId.get(otherId);
                                        return (
                                            <div key={`${edgeKey(edge, index)}-selected`}>
                                                <dt>{edge.relation}</dt>
                                                <dd>
                                                    <strong>{edge.weight.toLocaleString("en-US")}</strong>
                                                    <span>{nodeLabels.get(otherId) ?? otherId}</span>
                                                    {story ? (
                                                        <small>
                                                            {storyOutcomeLabel(story)}
                                                            {" / "}
                                                            {story.files_touched} files
                                                            {" / "}
                                                            {story.corrections} corrections
                                                            {story.review_pain ? ` / ${story.review_pain} review` : ""}
                                                            {story.merged_to_main ? " / main" : ""}
                                                        </small>
                                                    ) : null}
                                                </dd>
                                            </div>
                                        );
                                    })}
                                </dl>
                            )}
                        </div>
                    ) : null}

                    {data?.panels.map((panel) => (
                        <div className="graph-inspector-section" key={`${panel.kind}-${panel.title}`}>
                            <h3>{panel.title}</h3>
                            {panel.rows.length === 0 ? (
                                <p className="workflow-help">No rows.</p>
                            ) : (
                                <dl className="graph-panel-rows">
                                    {panel.rows.map((row) => (
                                        <div key={`${row.label}-${row.value}-${row.detail ?? ""}`}>
                                            <dt>{row.label}</dt>
                                            <dd>
                                                <strong>{row.value}</strong>
                                                {row.detail ? <span>{row.detail}</span> : null}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            )}
                        </div>
                    ))}
                </aside>
            </div>
        </section>
    );
}
