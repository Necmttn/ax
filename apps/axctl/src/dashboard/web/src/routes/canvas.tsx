import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import type { SessionCanvasNode, SessionCanvasPayload } from "@shared/dashboard-types.ts";

// Session Canvas - infinite-canvas, semantic-zoom view of session lineage.
//
// HYBRID CAMERA: one transform matrix {x, y, scale} drives BOTH an SVG glyph
// layer (cheap, all bands) and a CSS-transformed DOM overlay (rich HTML, near
// zoom only). The band the camera is in decides which layer owns a node -
// exactly the tldraw/Figma split. The DOM overlay is the shippable baseline of
// the "HTML in canvas" plan; the WICG html-in-canvas WebGL path
// (texElementImage2D, behind chrome://flags/#canvas-draw-element) is the
// drop-in upgrade for the same node components - see the design spec.

const WORLD_W = 2600;
const WORLD_H = 1800;

// Semantic-zoom band thresholds (on camera scale).
const ATLAS_MAX = 0.55;   // below -> dots only
const LINEAGE_MAX = 1.7;  // atlas..this -> context bars + edges; above -> + DOM cards

// Fixed screen-space card dimensions for the decluttered detail-band overlay.
const CARD_W = 190;
const CARD_H = 92;
const CARD_GAP = 6;
const MAX_CARDS = 16;

type Band = "atlas" | "lineage" | "detail";
const bandFor = (scale: number): Band =>
    scale < ATLAS_MAX ? "atlas" : scale < LINEAGE_MAX ? "lineage" : "detail";

interface Placed extends SessionCanvasNode {
    x: number;
    y: number;
}

const toneColor = (tone: string): string =>
    tone === "warning" ? "#c98a2e" : tone === "success" ? "#2e9e57" : "#5b6b86";

const pressureBorder = (p: string): string =>
    p === "high" ? "#e0563a" : p === "medium" ? "#c98a2e" : p === "low" ? "#2e7e44" : "#2a3650";

// Fruchterman-Reingold force layout in world space. Adapted from graph.tsx;
// disconnected nodes (solo sessions with no spawn edges) settle on a loose grid.
function layout(payload: SessionCanvasPayload): Placed[] {
    const srcNodes = payload.nodes ?? [];
    const srcEdges = payload.edges ?? [];
    const nodes: Placed[] = srcNodes.map((node, index) => {
        const angle = (index / Math.max(srcNodes.length, 1)) * Math.PI * 2;
        const radius = Math.min(WORLD_W, WORLD_H) * 0.36;
        return {
            ...node,
            x: WORLD_W / 2 + Math.cos(angle) * radius,
            y: WORLD_H / 2 + Math.sin(angle) * radius,
        };
    });
    if (nodes.length <= 1) {
        if (nodes[0]) {
            nodes[0].x = WORLD_W / 2;
            nodes[0].y = WORLD_H / 2;
        }
        return nodes;
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = srcEdges
        .map((e) => ({ s: byId.get(e.source), t: byId.get(e.target) }))
        .filter((e): e is { s: Placed; t: Placed } => !!e.s && !!e.t);

    const k = Math.sqrt((WORLD_W * WORLD_H) / nodes.length) * 0.7;
    let temp = Math.min(WORLD_W, WORLD_H) / 8;

    for (let iter = 0; iter < 90; iter++) {
        const disp = new Map<Placed, { dx: number; dy: number }>();
        for (const n of nodes) disp.set(n, { dx: 0, dy: 0 });
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i]!;
                const b = nodes[j]!;
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                if (dist > k * 4) continue;
                const force = (k * k) / dist;
                dx = (dx / dist) * force;
                dy = (dy / dist) * force;
                const ad = disp.get(a)!;
                const bd = disp.get(b)!;
                ad.dx += dx; ad.dy += dy;
                bd.dx -= dx; bd.dy -= dy;
            }
        }
        for (const e of edges) {
            const dx = e.s.x - e.t.x;
            const dy = e.s.y - e.t.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const force = (dist * dist) / k;
            const ux = (dx / dist) * force;
            const uy = (dy / dist) * force;
            const sd = disp.get(e.s)!;
            const td = disp.get(e.t)!;
            sd.dx -= ux; sd.dy -= uy;
            td.dx += ux; td.dy += uy;
        }
        for (const n of nodes) {
            const d = disp.get(n)!;
            const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy) || 0.01;
            n.x += (d.dx / len) * Math.min(len, temp);
            n.y += (d.dy / len) * Math.min(len, temp);
            n.x = Math.max(40, Math.min(WORLD_W - 40, n.x));
            n.y = Math.max(40, Math.min(WORLD_H - 40, n.y));
        }
        temp *= 0.95;
    }
    return nodes;
}

// size (conversational-turn volume) -> visual extent. The ratio is clamped to
// 1 against a p95 scale-max (see `sizeScaleMax`) so a single huge outlier (e.g.
// a Codex session with thousands of event rows) caps at the largest glyph
// instead of squashing every other node to the floor. sqrt softens the spread.
const dotRadius = (size: number, scaleMax: number): number =>
    5 + Math.sqrt(Math.min(1, size / Math.max(scaleMax, 1))) * 22;
const barWidth = (size: number, scaleMax: number): number =>
    24 + Math.sqrt(Math.min(1, size / Math.max(scaleMax, 1))) * 150;

interface Camera { x: number; y: number; scale: number; }

export function CanvasRoute() {
    const query = useQuery({
        queryKey: ["session-canvas"],
        queryFn: () => api.sessionCanvas({ limit: 800 }),
    });
    const data = query.data ?? null;

    const stageRef = useRef<HTMLDivElement | null>(null);
    const [box, setBox] = useState({ w: 900, h: 640 });
    const [cam, setCam] = useState<Camera>({ x: 0, y: 0, scale: 0.35 });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const dragRef = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);
    const fittedRef = useRef(false);

    useEffect(() => {
        if (!stageRef.current) return;
        const obs = new ResizeObserver((entries) => {
            for (const e of entries) {
                setBox({
                    w: Math.max(320, Math.floor(e.contentRect.width)),
                    h: Math.max(420, Math.floor(e.contentRect.height)),
                });
            }
        });
        obs.observe(stageRef.current);
        return () => obs.disconnect();
    }, []);

    const placed = useMemo(() => (data ? layout(data) : []), [data]);
    const posById = useMemo(() => new Map(placed.map((n) => [n.id, n])), [placed]);
    // p95 scale-max (not the true max) so a single huge outlier doesn't flatten
    // the scale. True per-node size still shows in the cards/inspector.
    const maxSize = useMemo(() => {
        if (placed.length === 0) return 1;
        const sorted = placed.map((n) => n.size).sort((a, b) => a - b);
        const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
        return Math.max(1, p95 ?? 1);
    }, [placed]);

    // Fit the world into the viewport once data + box are known.
    useEffect(() => {
        if (fittedRef.current || placed.length === 0) return;
        const fitScale = Math.min(box.w / WORLD_W, box.h / WORLD_H) * 0.92;
        setCam({
            scale: fitScale,
            x: (box.w - WORLD_W * fitScale) / 2,
            y: (box.h - WORLD_H * fitScale) / 2,
        });
        fittedRef.current = true;
    }, [placed, box]);

    const band = bandFor(cam.scale);

    const onWheel = (event: React.WheelEvent) => {
        event.preventDefault();
        const rect = stageRef.current?.getBoundingClientRect();
        if (!rect) return;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const factor = Math.exp(-event.deltaY * 0.0012);
        const next = Math.max(0.08, Math.min(6, cam.scale * factor));
        // keep the world point under the cursor fixed
        const wx = (px - cam.x) / cam.scale;
        const wy = (py - cam.y) / cam.scale;
        setCam({ scale: next, x: px - wx * next, y: py - wy * next });
    };
    const onPointerDown = (event: React.PointerEvent) => {
        (event.target as Element).setPointerCapture?.(event.pointerId);
        dragRef.current = { px: event.clientX, py: event.clientY, cx: cam.x, cy: cam.y };
    };
    const onPointerMove = (event: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        setCam((c) => ({ ...c, x: d.cx + (event.clientX - d.px), y: d.cy + (event.clientY - d.py) }));
    };
    const onPointerUp = () => { dragRef.current = null; };

    const fit = () => { fittedRef.current = false; setCam((c) => ({ ...c })); };
    const zoomBy = (factor: number) => {
        const cx = box.w / 2;
        const cy = box.h / 2;
        const next = Math.max(0.08, Math.min(6, cam.scale * factor));
        const wx = (cx - cam.x) / cam.scale;
        const wy = (cy - cam.y) / cam.scale;
        setCam({ scale: next, x: cx - wx * next, y: cy - wy * next });
    };

    const selected = selectedId ? posById.get(selectedId) ?? null : null;
    const connectedIds = useMemo(() => {
        if (!selectedId || !data) return null;
        const ids = new Set<string>([selectedId]);
        for (const e of data.edges ?? []) {
            if (e.source === selectedId) ids.add(e.target);
            if (e.target === selectedId) ids.add(e.source);
        }
        return ids;
    }, [data, selectedId]);

    // DOM-overlay cards live in SCREEN space at fixed pixel size (not the scaled
    // world layer) - map-label style, so they stay readable at any zoom instead
    // of ballooning. Then a greedy declutter: project + viewport-cull, sort by
    // priority (selected, then size), keep a card only if its screen rect does
    // not overlap an already-kept one. "Fit what fits, drop the rest" - the
    // dropped nodes still show as bars underneath. No collision lib needed.
    const overlayCards = useMemo(() => {
        if (band !== "detail") return [] as Array<{ n: Placed; x: number; y: number }>;
        const candidates = placed
            .map((n) => ({
                n,
                x: n.x * cam.scale + cam.x + (barWidth(n.size, maxSize) * cam.scale) / 2 + 8,
                y: n.y * cam.scale + cam.y - CARD_H / 2,
            }))
            .filter((c) => c.x > -CARD_W && c.x < box.w && c.y > -CARD_H && c.y < box.h);
        candidates.sort((a, b) =>
            (b.n.id === selectedId ? 1 : 0) - (a.n.id === selectedId ? 1 : 0) || b.n.size - a.n.size,
        );
        const kept: Array<{ n: Placed; x: number; y: number }> = [];
        for (const c of candidates) {
            const hit = kept.some((k) =>
                !(c.x + CARD_W + CARD_GAP < k.x || c.x > k.x + CARD_W + CARD_GAP ||
                  c.y + CARD_H + CARD_GAP < k.y || c.y > k.y + CARD_H + CARD_GAP),
            );
            if (hit) continue;
            kept.push(c);
            if (kept.length >= MAX_CARDS) break;
        }
        return kept;
    }, [band, placed, cam, box, maxSize, selectedId]);

    return (
        <section className="panel">
            <header>
                <h2>Session Canvas</h2>
                <span className="meta">
                    {data ? `${data.nodes?.length ?? 0} sessions / ${data.edges?.length ?? 0} spawn edges - ${band}` : "lineage"}
                </span>
            </header>

            <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0", flexWrap: "wrap" }}>
                <button type="button" onClick={() => zoomBy(1.3)}>+</button>
                <button type="button" onClick={() => zoomBy(1 / 1.3)}>-</button>
                <button type="button" onClick={fit}>Fit</button>
                <span style={{ fontSize: 12, color: "#7e8ba3" }}>
                    scale {cam.scale.toFixed(2)} - band <b>{band}</b> - scroll to zoom, drag to pan
                </span>
                {data?.warnings?.map((w) => (
                    <span key={w} style={{ fontSize: 11, color: "#c98a2e" }}>{w}</span>
                ))}
            </div>

            <div
                ref={stageRef}
                onWheel={onWheel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                style={{
                    position: "relative",
                    height: "70vh",
                    background: "#0b0e14",
                    border: "1px solid #1e2633",
                    borderRadius: 10,
                    overflow: "hidden",
                    cursor: dragRef.current ? "grabbing" : "grab",
                    touchAction: "none",
                }}
            >
                {query.isLoading ? <div style={{ padding: 16, color: "#7e8ba3" }}>Loading canvas...</div> : null}
                {query.error ? <div style={{ padding: 16, color: "#e0563a" }}>Error: {String(query.error)}</div> : null}

                {/* SVG glyph layer - all bands. Camera via <g> transform. */}
                <svg width={box.w} height={box.h} style={{ position: "absolute", inset: 0 }} aria-label="Session canvas">
                    <g transform={`translate(${cam.x}, ${cam.y}) scale(${cam.scale})`}>
                        {data?.edges?.map((e, i) => {
                            const s = posById.get(e.source);
                            const t = posById.get(e.target);
                            if (!s || !t) return null;
                            const active = !connectedIds || connectedIds.has(e.source) || connectedIds.has(e.target);
                            return (
                                <line
                                    key={`${e.source}-${e.target}-${i}`}
                                    x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                                    stroke="#2f6df0"
                                    strokeWidth={1.4 / cam.scale}
                                    opacity={active ? 0.5 : 0.12}
                                />
                            );
                        })}
                        {placed.map((n) => {
                            const dim = connectedIds && !connectedIds.has(n.id);
                            const fill = toneColor(n.tone);
                            const stroke = pressureBorder(n.context_pressure);
                            if (band === "atlas") {
                                const r = dotRadius(n.size, maxSize);
                                return (
                                    <circle
                                        key={n.id} cx={n.x} cy={n.y} r={r}
                                        fill={`${fill}55`} stroke={fill} strokeWidth={1.2 / cam.scale}
                                        opacity={dim ? 0.3 : 1}
                                        style={{ cursor: "pointer" }}
                                        onClick={() => setSelectedId(n.id)}
                                    />
                                );
                            }
                            // lineage + detail bands: context bar (width = size proxy)
                            const w = barWidth(n.size, maxSize);
                            const h = 22;
                            return (
                                <g key={n.id} transform={`translate(${n.x - w / 2}, ${n.y - h / 2})`}
                                   opacity={dim ? 0.3 : 1} style={{ cursor: "pointer" }}
                                   onClick={() => setSelectedId(n.id)}>
                                    <rect width={w} height={h} rx={5}
                                          fill={`${fill}44`} stroke={n.id === selectedId ? "#fff" : stroke}
                                          strokeWidth={(n.id === selectedId ? 2 : 1.2) / cam.scale} />
                                    {/* epoch notches (epochs=1 in v0 -> none; ready for compaction ingest) */}
                                    {Array.from({ length: Math.max(0, n.epochs - 1) }).map((_, k) => (
                                        <rect key={k} x={(w * (k + 1)) / n.epochs - 1} y={-2}
                                              width={2} height={h + 4} fill="#e0563a" />
                                    ))}
                                    {n.is_subagent ? (
                                        <circle cx={6} cy={h / 2} r={3} fill="#4a3fa0" />
                                    ) : null}
                                    {cam.scale > 0.9 ? (
                                        <text x={w / 2} y={h / 2 + 4} textAnchor="middle"
                                              fontSize={11 / cam.scale} fill="#cfe0ff"
                                              style={{ pointerEvents: "none" }}>
                                            {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                                        </text>
                                    ) : null}
                                </g>
                            );
                        })}
                    </g>
                </svg>

                {/* DOM overlay layer - SCREEN space, fixed pixel size, decluttered.
                    Live HTML React nodes positioned at projected node coords; no
                    camera scale so text stays crisp at any zoom. This is exactly the
                    layer html-in-canvas would texture into WebGL (texElementImage2D). */}
                <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                    {overlayCards.map(({ n, x, y }) => (
                        <div
                            key={n.id}
                            onClick={() => setSelectedId(n.id)}
                            style={{
                                position: "absolute",
                                left: x,
                                top: y,
                                width: CARD_W,
                                height: CARD_H,
                                boxSizing: "border-box",
                                overflow: "hidden",
                                background: "#0e1320ee",
                                border: `1px solid ${n.id === selectedId ? "#fff" : toneColor(n.tone)}`,
                                borderRadius: 6,
                                padding: "6px 8px",
                                fontSize: 11,
                                color: "#9fc0ff",
                                pointerEvents: "auto",
                                cursor: "pointer",
                            }}
                        >
                            <div style={{ fontWeight: 600, color: "#cfe0ff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {n.label}
                            </div>
                            <div style={{ color: "#7e8ba3", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {n.project ?? "no project"} - {n.source}
                            </div>
                            <div style={{ color: "#7e8ba3", marginTop: 2 }}>
                                {n.size} turns - ctx {n.context_pressure}
                                {n.corrections > 0 ? ` - ${n.corrections} corr` : ""}
                            </div>
                            <Link
                                to="/sessions/$sessionId/inspect"
                                params={{ sessionId: n.id }}
                                style={{ color: "#2f6df0", fontSize: 11 }}
                            >
                                inspect turns →
                            </Link>
                        </div>
                    ))}
                </div>
            </div>

            {selected ? (
                <div style={{ marginTop: 10, padding: 10, border: "1px solid #1e2633", borderRadius: 8 }}>
                    <div style={{ fontWeight: 600 }}>{selected.label}</div>
                    <div style={{ color: "#7e8ba3", fontSize: 12, marginTop: 4 }}>
                        {selected.project ?? "no project"} - {selected.source} - {selected.size} turns -
                        ctx pressure {selected.context_pressure}
                        {selected.is_subagent ? " - subagent" : ""}
                    </div>
                    <Link to="/sessions/$sessionId/inspect" params={{ sessionId: selected.id }}
                          style={{ color: "#2f6df0", fontSize: 13 }}>
                        Open session (L3 - turn content) →
                    </Link>
                </div>
            ) : null}
        </section>
    );
}
