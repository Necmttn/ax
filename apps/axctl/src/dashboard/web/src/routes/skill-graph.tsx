import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "../api.ts";
import { fmtCount } from "@shared/formatters.ts";
import type {
    SkillGraphEdge,
    SkillGraphNode,
    SkillGraphPayload,
} from "@shared/dashboard-types.ts";

interface LaidOutNode extends SkillGraphNode {
    x: number;
    y: number;
}

/**
 * Tiny force-directed layout. ~80 iterations of Fruchterman-Reingold style
 * repulsion + spring attraction is plenty for 50-200 nodes - no need for
 * d3-force here.
 */
function layout(payload: SkillGraphPayload, width: number, height: number): LaidOutNode[] {
    const nodes: LaidOutNode[] = payload.nodes.map((n, i) => {
        // Seed positions evenly around a circle so the first frame is readable
        // even if the user never lets the sim converge.
        const angle = (i / Math.max(payload.nodes.length, 1)) * Math.PI * 2;
        const r = Math.min(width, height) * 0.35;
        return {
            ...n,
            x: width / 2 + Math.cos(angle) * r,
            y: height / 2 + Math.sin(angle) * r,
        };
    });
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const edges = payload.edges
        .map((e) => ({ s: byName.get(e.source), t: byName.get(e.target), w: e.count }))
        .filter((e): e is { s: LaidOutNode; t: LaidOutNode; w: number } => !!e.s && !!e.t);

    if (nodes.length === 0) return nodes;
    const area = width * height;
    const k = Math.sqrt(area / nodes.length) * 0.7;
    let temperature = Math.min(width, height) / 10;
    const iterations = 80;
    const maxEdge = payload.max_edge_count || 1;

    for (let it = 0; it < iterations; it++) {
        const disp = new Map<LaidOutNode, { dx: number; dy: number }>();
        for (const n of nodes) disp.set(n, { dx: 0, dy: 0 });

        // Repulsion (all-pairs; fine up to ~300 nodes).
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i]!;
                const b = nodes[j]!;
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                if (dist > k * 4) continue; // far-field cutoff
                const force = (k * k) / dist;
                dx = (dx / dist) * force;
                dy = (dy / dist) * force;
                const da = disp.get(a)!;
                const db = disp.get(b)!;
                da.dx += dx;
                da.dy += dy;
                db.dx -= dx;
                db.dy -= dy;
            }
        }

        // Attraction along edges, weighted by co-occurrence count.
        for (const e of edges) {
            const dx = e.s.x - e.t.x;
            const dy = e.s.y - e.t.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const wf = 0.5 + (e.w / maxEdge) * 1.5;
            const force = ((dist * dist) / k) * wf;
            const ux = (dx / dist) * force;
            const uy = (dy / dist) * force;
            const ds = disp.get(e.s)!;
            const dt = disp.get(e.t)!;
            ds.dx -= ux;
            ds.dy -= uy;
            dt.dx += ux;
            dt.dy += uy;
        }

        // Apply, capped by temperature; cool linearly.
        for (const n of nodes) {
            const d = disp.get(n)!;
            const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy) || 0.01;
            n.x += (d.dx / len) * Math.min(len, temperature);
            n.y += (d.dy / len) * Math.min(len, temperature);
            // Clamp to viewport with a small margin.
            n.x = Math.max(20, Math.min(width - 20, n.x));
            n.y = Math.max(20, Math.min(height - 20, n.y));
        }
        temperature *= 0.95;
    }
    return nodes;
}

const radiusFor = (weight: number, maxWeight: number): number =>
    4 + (weight / Math.max(maxWeight, 1)) * 12;

const PHASE_TONE = (name: string): string => {
    const n = name.toLowerCase();
    if (n.includes("review") || n.includes("test")) return "var(--green)";
    if (n.includes("plan") || n.includes("brainstorm") || n.includes("research")) return "var(--gold)";
    if (n.includes("merge") || n.includes("ship") || n.includes("deploy")) return "var(--ink)";
    return "var(--blue)";
};

export function SkillGraphRoute() {
    const navigate = useNavigate({ from: "/skills/graph" });
    const search = useSearch({ from: "/skills/graph" });
    const [minCount, setMinCount] = useState<number>(search.minCount ?? 10);
    const [hovered, setHovered] = useState<string | null>(null);

    const effectiveMinCount = search.minCount ?? 10;

    const query = useQuery({
        queryKey: ["skill-graph", effectiveMinCount],
        queryFn: () => api.skillGraph({ minCount: effectiveMinCount, limit: 400 }),
    });
    const data = query.data ?? null;
    const loading = query.isLoading;
    const error = query.error ? String(query.error) : null;

    const ref = useRef<HTMLDivElement | null>(null);
    const [box, setBox] = useState<{ w: number; h: number }>({ w: 800, h: 540 });
    useEffect(() => {
        if (!ref.current) return;
        const obs = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setBox({
                    w: Math.max(400, Math.floor(entry.contentRect.width)),
                    h: Math.max(360, Math.floor(entry.contentRect.height)),
                });
            }
        });
        obs.observe(ref.current);
        return () => obs.disconnect();
    }, []);

    const laid = useMemo(() => {
        if (!data) return [] as LaidOutNode[];
        return layout(data, box.w, box.h);
    }, [data, box.w, box.h]);

    const positions = useMemo(
        () => new Map(laid.map((n) => [n.name, n])),
        [laid],
    );

    const maxNodeWeight = useMemo(
        () => laid.reduce((m, n) => (n.weight > m ? n.weight : m), 0),
        [laid],
    );

    const applyMinCount = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        void navigate({
            search: {
                minCount: Number.isFinite(minCount) && minCount > 0 ? minCount : undefined,
            },
        });
    };

    return (
        <section className="panel">
            <header>
                <h2>Skill graph</h2>
                <span className="meta">
                    {data
                        ? `${fmtCount(data.node_count)} skills · ${fmtCount(data.edge_count)} pairs · min count ${data.min_count}`
                        : "Skill pair graph"}
                </span>
            </header>

            <form
                onSubmit={applyMinCount}
                style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    marginBottom: 12,
                    fontSize: 12,
                }}
            >
                <label>
                    min co-occurrence:{" "}
                    <input
                        type="number"
                        min={1}
                        value={minCount}
                        onChange={(e) => setMinCount(Number(e.target.value))}
                        style={{ width: 80, padding: "4px 6px" }}
                    />
                </label>
                <button type="submit" className="badge keep">
                    Apply
                </button>
                <small style={{ color: "var(--muted)" }}>
                    Higher = denser pairs only. Lower = include rare combinations.
                </small>
            </form>

            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}

            <div
                ref={ref}
                className="skill-graph-canvas"
                style={{ width: "100%", height: 540, background: "var(--panel)", border: "1px solid var(--line)", position: "relative" }}
            >
                {data && data.nodes.length === 0 ? (
                    <p style={{ padding: 16, color: "var(--muted)" }}>
                        No pairs at min count {data.min_count}. Try lowering it.
                    </p>
                ) : null}
                <svg width={box.w} height={box.h} style={{ display: "block" }}>
                    <g>
                        {data?.edges.map((e, i) => {
                            const a = positions.get(e.source);
                            const b = positions.get(e.target);
                            if (!a || !b) return null;
                            const isHover =
                                hovered != null &&
                                (hovered === e.source || hovered === e.target);
                            return (
                                <line
                                    key={i}
                                    x1={a.x}
                                    y1={a.y}
                                    x2={b.x}
                                    y2={b.y}
                                    stroke={isHover ? "var(--ink)" : "var(--line)"}
                                    strokeWidth={Math.max(0.5, (e.count / (data.max_edge_count || 1)) * 2.5)}
                                    strokeOpacity={isHover ? 0.9 : 0.4}
                                />
                            );
                        })}
                        {laid.map((n) => {
                            const isHover = hovered === n.name;
                            return (
                                <g
                                    key={n.name}
                                    transform={`translate(${n.x}, ${n.y})`}
                                    onMouseEnter={() => setHovered(n.name)}
                                    onMouseLeave={() => setHovered((h) => (h === n.name ? null : h))}
                                    style={{ cursor: "pointer" }}
                                >
                                    <Link
                                        to="/skills"
                                        search={{ q: n.name }}
                                    >
                                        <circle
                                            r={radiusFor(n.weight, maxNodeWeight)}
                                            fill={PHASE_TONE(n.name)}
                                            stroke="var(--ink)"
                                            strokeWidth={isHover ? 2 : 0.5}
                                            opacity={isHover ? 1 : 0.85}
                                        />
                                        <text
                                            x={radiusFor(n.weight, maxNodeWeight) + 4}
                                            y={3}
                                            fontSize={isHover ? 12 : 10}
                                            fill={isHover ? "var(--ink)" : "var(--muted)"}
                                            style={{ pointerEvents: "none" }}
                                        >
                                            {n.name}
                                        </text>
                                    </Link>
                                </g>
                            );
                        })}
                    </g>
                </svg>
            </div>

            {data && data.nodes.length > 0 ? (
                <p className="workflow-help" style={{ marginTop: 12 }}>
                    Click a node to see the skill in the triage view. Bigger circle =
                    higher total co-occurrence weight; thicker edge = more pairs.
                </p>
            ) : null}
        </section>
    );
}
