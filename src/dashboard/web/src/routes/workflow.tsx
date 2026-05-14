import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import type {
    EpisodeShapeAggregate,
    SessionShapeAggregate,
    WorkflowConvergencePoint,
    WorkflowEpisode,
    WorkflowResponse,
    WorkflowWeekBucket,
} from "@shared/dashboard-types.ts";
import { fmtCount, fmtTs } from "@shared/formatters.ts";
import { prettifyProjectSlug } from "@shared/project-slug.ts";
import { PHASE_LABEL, type Phase } from "@shared/phases.ts";

const HEATMAP_TOP_N = 12;

/**
 * Build a {label -> {week -> count}} matrix limited to the union of each
 * week's top-N labels. Keeps the heatmap from blowing up to 200 rows.
 */
function buildMatrix(
    buckets: ReadonlyArray<WorkflowWeekBucket>,
    topN: number,
): {
    labels: string[];
    weeks: string[];
    cells: Record<string, Record<string, number>>;
    maxByWeek: Record<string, number>;
} {
    const labelSet = new Set<string>();
    for (const bucket of buckets) {
        for (const c of bucket.counts.slice(0, topN)) labelSet.add(c.label);
    }
    const cells: Record<string, Record<string, number>> = {};
    const maxByWeek: Record<string, number> = {};
    for (const label of labelSet) cells[label] = {};
    for (const bucket of buckets) {
        let max = 0;
        for (const c of bucket.counts) {
            if (c.count > max) max = c.count;
            if (labelSet.has(c.label)) {
                cells[c.label]![bucket.week] = c.count;
            }
        }
        maxByWeek[bucket.week] = max;
    }
    const labels = Array.from(labelSet).sort((a, b) => {
        // Sort by total count desc so the busiest skill is on top.
        const totalA = Object.values(cells[a]!).reduce((s, v) => s + v, 0);
        const totalB = Object.values(cells[b]!).reduce((s, v) => s + v, 0);
        return totalB - totalA;
    });
    const weeks = buckets.map((b) => b.week);
    return { labels, weeks, cells, maxByWeek };
}

const intensity = (count: number, max: number): string => {
    if (count === 0 || max === 0) return "rgba(37, 103, 168, 0)";
    const ratio = Math.min(1, Math.log10(count + 1) / Math.log10(max + 1));
    const alpha = 0.08 + 0.7 * ratio;
    return `rgba(37, 103, 168, ${alpha.toFixed(3)})`;
};

const jaccardWidth = (point: WorkflowConvergencePoint): number => {
    if (point.jaccard === null) return 0;
    return Math.round(point.jaccard * 100);
};

export function WorkflowRoute() {
    const wfQuery = useQuery({
        queryKey: ["workflow"],
        queryFn: () => api.workflow(),
    });
    const data = wfQuery.data ?? null;
    const loading = wfQuery.isLoading;
    const error = wfQuery.error ? String(wfQuery.error) : null;

    const skillsMatrix = useMemo(
        () => (data ? buildMatrix(data.skills, HEATMAP_TOP_N) : null),
        [data],
    );
    const toolsMatrix = useMemo(
        () => (data ? buildMatrix(data.tools, HEATMAP_TOP_N) : null),
        [data],
    );

    return (
        <section className="panel">
            <header>
                <h2>Workflow</h2>
                <span className="meta">
                    {data
                        ? `${data.weeksLookback}-week lookback · top ${data.topK} convergence · generated ${fmtTs(data.generatedAt)}`
                        : ""}
                </span>
            </header>

            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}

            {data ? (
                <>
                    <div className="workflow-narrative">{data.narrative}</div>

                    {data.episode_shapes.length > 0 ? (
                        <>
                            <h3 className="workflow-h3">
                                Episode shapes (multi-session workflows)
                            </h3>
                            <p className="workflow-help">
                                Compressed phase sequences from <strong>subagent activity</strong>
                                {" "}within each episode (parent + spawned children). This is where{" "}
                                <code>/review-all</code> orchestrators show up as pure{" "}
                                <code>R</code> shapes. Counted across {data.episode_shapes_total}{" "}
                                episodes.
                            </p>
                            <EpisodeShapes shapes={data.episode_shapes} />
                        </>
                    ) : null}

                    {data.episodes.length > 0 ? (
                        <>
                            <h3 className="workflow-h3">
                                Work episodes (parent + spawned subagents)
                            </h3>
                            <p className="workflow-help">
                                Top sessions that fanned out subagents via codex{" "}
                                <code>spawn_agent</code> or Claude <code>Task</code>.
                                One row = one user-driven workflow that actually spans
                                many sessions.
                            </p>
                            <EpisodesTable episodes={data.episodes} />
                        </>
                    ) : null}

                    <h3 className="workflow-h3">Your typical session</h3>
                    <p className="workflow-help">
                        Each session's invocations classified into Plan / Execute /
                        Review / Merge phases, consecutive-deduped, then grouped.
                        Counted across {data.shapesTotal} sessions in the last{" "}
                        {data.weeksLookback} weeks.
                    </p>
                    <SessionShapes shapes={data.shapes} total={data.shapesTotal} />

                    <h3 className="workflow-h3">Week-over-week convergence</h3>
                    <p className="workflow-help">
                        Jaccard similarity of each week's top-{data.topK} skill set vs the
                        previous week. Higher = more stable workflow. Lower = active
                        exploration / churn.
                    </p>
                    <ConvergenceTable points={data.convergence} />

                    {skillsMatrix ? (
                        <>
                            <h3 className="workflow-h3">Skill mix per week</h3>
                            <p className="workflow-help">
                                Each row is a skill; cell intensity = invocations that
                                week (log scale).
                            </p>
                            <Heatmap
                                labels={skillsMatrix.labels}
                                weeks={skillsMatrix.weeks}
                                cells={skillsMatrix.cells}
                                maxByWeek={skillsMatrix.maxByWeek}
                                linkBase="/skills"
                            />
                        </>
                    ) : null}

                    {toolsMatrix ? (
                        <>
                            <h3 className="workflow-h3">Tool mix per week</h3>
                            <p className="workflow-help">
                                Same shape, but for shell commands / tool calls. Click a
                                row to see failure samples.
                            </p>
                            <Heatmap
                                labels={toolsMatrix.labels}
                                weeks={toolsMatrix.weeks}
                                cells={toolsMatrix.cells}
                                maxByWeek={toolsMatrix.maxByWeek}
                                linkBase="/tools"
                            />
                        </>
                    ) : null}

                    <h3 className="workflow-h3">Sessions per week</h3>
                    <table className="skills">
                        <thead>
                            <tr>
                                <th>Week</th>
                                <th className="num">Sessions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.sessionShape.map((row) => (
                                <tr key={row.week}>
                                    <td>{row.week}</td>
                                    <td className="num">{fmtCount(row.session_count)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            ) : null}
        </section>
    );
}

function ConvergenceTable({
    points,
}: {
    points: ReadonlyArray<WorkflowConvergencePoint>;
}) {
    return (
        <table className="skills convergence-table">
            <thead>
                <tr>
                    <th>Week</th>
                    <th>Jaccard</th>
                    <th>Top {points[0]?.topK.length ?? 0} skills</th>
                    <th>New / Dropped</th>
                </tr>
            </thead>
            <tbody>
                {points.map((p) => (
                    <tr key={p.week}>
                        <td>{p.week}</td>
                        <td>
                            {p.jaccard === null ? (
                                <small>-</small>
                            ) : (
                                <div className="jaccard-bar">
                                    <span className="jaccard-num">
                                        {Math.round((p.jaccard ?? 0) * 100)}%
                                    </span>
                                    <div
                                        className="jaccard-fill"
                                        style={{ width: `${jaccardWidth(p)}%` }}
                                    />
                                </div>
                            )}
                        </td>
                        <td>
                            <small>{p.topK.slice(0, 5).join(", ")}…</small>
                        </td>
                        <td>
                            {p.newcomers.length > 0 ? (
                                <small className="text-green">
                                    + {p.newcomers.slice(0, 3).join(", ")}
                                </small>
                            ) : null}
                            {p.dropouts.length > 0 ? (
                                <small className="text-muted">
                                    − {p.dropouts.slice(0, 3).join(", ")}
                                </small>
                            ) : null}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function Heatmap({
    labels,
    weeks,
    cells,
    maxByWeek,
    linkBase,
}: {
    labels: ReadonlyArray<string>;
    weeks: ReadonlyArray<string>;
    cells: Record<string, Record<string, number>>;
    maxByWeek: Record<string, number>;
    linkBase: "/skills" | "/tools";
}) {
    return (
        <div className="heatmap-wrap">
            <table className="heatmap">
                <thead>
                    <tr>
                        <th />
                        {weeks.map((w) => (
                            <th key={w}>{w.replace(/^\d{4}-/, "")}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {labels.map((label) => (
                        <tr key={label}>
                            <th scope="row">
                                <Link to={linkBase} search={{ q: label }}>
                                    {label}
                                </Link>
                            </th>
                            {weeks.map((w) => {
                                const count = cells[label]?.[w] ?? 0;
                                const max = maxByWeek[w] ?? 1;
                                return (
                                    <td
                                        key={w}
                                        title={`${label} · ${w} · ${count}`}
                                        style={{
                                            backgroundColor: intensity(count, max),
                                        }}
                                    >
                                        {count > 0 ? (
                                            <small>{count >= 1000 ? `${(count / 1000).toFixed(1)}k` : count}</small>
                                        ) : null}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

const PHASE_TONE: Record<Phase, string> = {
    plan: "var(--gold)",
    execute: "var(--blue)",
    review: "var(--green)",
    merge: "var(--ink)",
    other: "var(--muted)",
};

function PhaseBadge({ phase }: { phase: Phase }) {
    return (
        <span
            className="phase-badge"
            style={{ backgroundColor: PHASE_TONE[phase] }}
            title={PHASE_LABEL[phase]}
        >
            {phase[0]?.toUpperCase()}
        </span>
    );
}

function SessionShapes({
    shapes,
    total,
}: {
    shapes: ReadonlyArray<SessionShapeAggregate>;
    total: number;
}) {
    const single = shapes.filter((s) => s.phases.length === 1);
    const multi = shapes.filter((s) => s.phases.length >= 2);
    return (
        <div className="shapes-grid">
            <div>
                <h4 className="shapes-subhead">Multi-phase patterns</h4>
                {multi.length === 0 ? (
                    <p className="empty">no multi-phase shapes detected yet</p>
                ) : (
                    <ul className="shape-list">
                        {multi.map((s) => (
                            <ShapeRow key={s.shape} shape={s} total={total} />
                        ))}
                    </ul>
                )}
            </div>
            <div>
                <h4 className="shapes-subhead">Single-phase sessions</h4>
                {single.length === 0 ? (
                    <p className="empty">none</p>
                ) : (
                    <ul className="shape-list">
                        {single.map((s) => (
                            <ShapeRow key={s.shape} shape={s} total={total} />
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

function ShapeRow({
    shape,
    total,
}: {
    shape: SessionShapeAggregate;
    total: number;
}) {
    const pct = total === 0 ? 0 : Math.round((shape.session_count / total) * 100);
    return (
        <li>
            <div className="shape-phases">
                {shape.phases.map((p, i) => (
                    <span key={`${p}-${i}`} className="shape-phase">
                        <PhaseBadge phase={p} />
                        {i < shape.phases.length - 1 ? (
                            <span className="shape-arrow">→</span>
                        ) : null}
                    </span>
                ))}
            </div>
            <div className="shape-meta">
                <strong>{shape.session_count}</strong>
                <small> sessions ({pct}%)</small>
            </div>
        </li>
    );
}

function EpisodesTable({
    episodes,
}: {
    episodes: ReadonlyArray<WorkflowEpisode>;
}) {
    return (
        <table className="skills">
            <thead>
                <tr>
                    <th>Started</th>
                    <th>Project</th>
                    <th className="num">Subagents</th>
                    <th className="num">Distinct names</th>
                    <th>Parent session</th>
                    <th>Episode</th>
                </tr>
            </thead>
            <tbody>
                {episodes.map((ep) => (
                    <tr key={ep.parent_session_id}>
                        <td>
                            <code>{ep.started_at ? fmtTs(ep.started_at) : "—"}</code>
                        </td>
                        <td>
                            {ep.project ? (
                                <Link
                                    to="/projects/$slug"
                                    params={{ slug: ep.project }}
                                    style={{ textDecoration: "none" }}
                                >
                                    <strong>{prettifyProjectSlug(ep.project)}</strong>
                                </Link>
                            ) : (
                                <strong>{prettifyProjectSlug(ep.project)}</strong>
                            )}
                        </td>
                        <td className="num">
                            <strong>{ep.child_count}</strong>
                        </td>
                        <td className="num">{ep.distinct_nicknames}</td>
                        <td>
                            <Link
                                to="/sessions/$sessionId"
                                params={{ sessionId: ep.parent_session_id }}
                                title="open session"
                            >
                                <code>
                                    {ep.parent_session_id
                                        .replace(/^session:⟨/, "")
                                        .replace(/⟩$/, "")
                                        .slice(0, 12)}
                                    …
                                </code>
                            </Link>
                        </td>
                        <td>
                            <Link
                                to="/episodes/$parentId"
                                params={{ parentId: ep.parent_session_id }}
                                title="open episode timeline"
                                className="badge keep"
                                style={{ textDecoration: "none" }}
                            >
                                timeline →
                            </Link>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function EpisodeShapes({
    shapes,
}: {
    shapes: ReadonlyArray<EpisodeShapeAggregate>;
}) {
    return (
        <ul className="shape-list" style={{ marginBottom: 16 }}>
            {shapes.map((s) => (
                <li key={s.shape}>
                    <div className="shape-phases">
                        {s.phases.map((p, i) => (
                            <span key={`${p}-${i}`} className="shape-phase">
                                <PhaseBadge phase={p} />
                                {i < s.phases.length - 1 ? (
                                    <span className="shape-arrow">→</span>
                                ) : null}
                            </span>
                        ))}
                    </div>
                    <div className="shape-meta">
                        <strong>{s.episode_count}</strong>
                        <small> episode{s.episode_count === 1 ? "" : "s"} · avg {s.avg_children} subagents</small>
                    </div>
                </li>
            ))}
        </ul>
    );
}
