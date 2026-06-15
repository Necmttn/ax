import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import type {
    ContextBudgetResult,
    ContextSkillRow,
    ContextSourceRow,
} from "../api.ts";
import { fmtCount } from "@ax/lib/shared/formatters";

/* ===========================================================================
   SESSION CONTEXT BUDGET
   What fills your context before you type anything in a fresh Claude Code /
   Codex session. Skills cost tokens two ways:
     - INDEX  (index_tokens): always-loaded. Every skill's name + description
       sits in the system-prompt skill catalog of EVERY session. This is the
       tax you pay on turn zero.
     - BODY   (body_tokens): on-demand. The SKILL.md body, only loaded when the
       skill is actually invoked.
   The page reveals that cost and lets you navigate the skills as an index.
   No triage. These are real measurements - let the numbers speak.
   ========================================================================= */

/** chars/4 token est is already done server-side; we format for display. */
const fmtTokens = (n: number): string => fmtCount(Math.round(n));

/** Source palette: colour lives in the data-viz, keyed to the source so the
 *  stacked budget bar reads as one instrument. Green is the house accent and
 *  belongs to the dominant user-skills slice; the rest spread across the
 *  luminance-matched accent set. NOT orange (reserved for alert). */
const SOURCE_HUES = [
    "var(--green)",
    "var(--blue)",
    "var(--violet)",
    "var(--gold)",
    "var(--rose, #b32650)",
    "color-mix(in srgb, var(--green) 55%, var(--blue))",
    "color-mix(in srgb, var(--violet) 60%, var(--surface2))",
    "color-mix(in srgb, var(--blue) 55%, var(--surface2))",
] as const;

type SortKey = "body" | "index" | "name" | "source";
type SortDir = "asc" | "desc";

const DEFAULT_DIR: Record<SortKey, SortDir> = {
    body: "desc",
    index: "desc",
    name: "asc",
    source: "asc",
};

const RENDER_PAGE = 80;

/** Stable hue per source name (so colour survives sort/filter and matches the
 *  legend even when the row order changes). */
function buildHueMap(sources: ReadonlyArray<ContextSourceRow>): Map<string, string> {
    const map = new Map<string, string>();
    sources.forEach((s, i) => {
        map.set(s.source, SOURCE_HUES[i % SOURCE_HUES.length]);
    });
    return map;
}

export function SkillsRoute() {
    const budget = useQuery({
        queryKey: ["context-budget"],
        queryFn: () => api.contextBudget(),
    });
    const data: ContextBudgetResult | null = budget.data ?? null;
    const loading = budget.isLoading;
    const refreshing = budget.isFetching && !budget.isLoading;
    const error = budget.error ? String(budget.error) : null;

    const [showTools, setShowTools] = useState(false);
    const [search, setSearch] = useState("");
    const [sourceFilter, setSourceFilter] = useState<string | null>(null);
    const [sortKey, setSortKey] = useState<SortKey>("body");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [renderLimit, setRenderLimit] = useState(RENDER_PAGE);
    const searchRef = useRef<HTMLInputElement | null>(null);

    // Split Claude-Code session sources from the other-harness tool catalogs.
    // The headline is the Claude Code session footprint; tools live behind a
    // toggle so they never inflate the numbers that matter.
    const ccSources = useMemo(
        () => (data ? data.sources.filter((s) => !s.is_tool) : []),
        [data],
    );
    const toolSources = useMemo(
        () => (data ? data.sources.filter((s) => s.is_tool) : []),
        [data],
    );
    const hueMap = useMemo(() => buildHueMap(ccSources), [ccSources]);

    // The always-loaded tax: sum of session-source index tokens. This is the
    // headline. cc_index_tokens from totals is the authoritative figure.
    const indexTotal = data?.totals.cc_index_tokens ?? 0;
    const bodyTotal = data?.totals.cc_body_tokens ?? 0;
    const ccSkillCount = useMemo(
        () => ccSources.reduce((n, s) => n + s.skills, 0),
        [ccSources],
    );

    // Stacked-bar segments over the session index budget only.
    const indexSum = useMemo(
        () => ccSources.reduce((n, s) => n + s.index_tokens, 0),
        [ccSources],
    );
    const maxIndexSource = useMemo(
        () => ccSources.reduce((m, s) => Math.max(m, s.index_tokens), 0),
        [ccSources],
    );

    const visibleSkills = useMemo(() => {
        if (!data) return [];
        const q = search.trim().toLowerCase();
        let rows = data.skills.filter((s) => showTools || !s.is_tool);
        if (sourceFilter) rows = rows.filter((s) => s.source === sourceFilter);
        if (q) {
            rows = rows.filter(
                (s) =>
                    s.name.toLowerCase().includes(q) ||
                    s.source.toLowerCase().includes(q) ||
                    s.scope.toLowerCase().includes(q),
            );
        }
        return sortSkills(rows, sortKey, sortDir);
    }, [data, showTools, sourceFilter, search, sortKey, sortDir]);

    const rendered = useMemo(
        () => visibleSkills.slice(0, renderLimit),
        [visibleSkills, renderLimit],
    );
    const hasMore = rendered.length < visibleSkills.length;
    // Relative body bar normalized to the largest rendered body - a readout the
    // eye can calibrate, not a raw absolute.
    const maxBody = useMemo(
        () => rendered.reduce((m, s) => Math.max(m, s.body_tokens), 0),
        [rendered],
    );

    useEffect(() => {
        setRenderLimit(RENDER_PAGE);
    }, [search, sourceFilter, showTools, sortKey, sortDir]);

    // `/` to focus search, esc to leave.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            const tag = t?.tagName ?? "";
            if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) {
                if (e.key === "Escape" && t instanceof HTMLInputElement) t.blur();
                return;
            }
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === "/") {
                e.preventDefault();
                searchRef.current?.focus();
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, []);

    const onSortClick = (key: SortKey) => {
        if (key === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
        else {
            setSortKey(key);
            setSortDir(DEFAULT_DIR[key]);
        }
    };

    return (
        <section className="panel ctx-budget skills-instrument">
            <header className="inst-head">
                <div className="inst-head-top">
                    <div>
                        <div className="inst-kicker">$ ax context</div>
                        <h2 className="inst-title">Context Budget</h2>
                        {data ? (
                            <div className="inst-head-meta" style={{ marginTop: 8 }}>
                                <b>{fmtCount(ccSkillCount)}</b> skills
                                <span>·</span>
                                <b>{fmtCount(ccSources.length)}</b> sources
                                <span>·</span>
                                <span className="live">
                                    <span className="rdx-led" aria-hidden="true" />live
                                </span>
                            </div>
                        ) : null}
                    </div>
                    {data ? (
                        <div className="inst-hero ctx-hero">
                            <span className="rdx-doto n">{fmtTokens(indexTotal)}</span>
                            <span className="l">tokens loaded into every session before you type</span>
                            <span className="ctx-hero-sub">
                                + <b>{fmtTokens(bodyTotal)}</b> on demand, only when a skill runs
                            </span>
                        </div>
                    ) : null}
                </div>
            </header>

            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}

            {data ? (
                <>
                    {/* --- WHERE THE BUDGET GOES: always-loaded index by source --- */}
                    <section className="ctx-breakdown">
                        <div className="ctx-breakdown-head">
                            <h3>Where the always-loaded budget goes</h3>
                            <span className="ctx-breakdown-note">
                                {fmtTokens(indexSum)} index tokens · every session, turn zero
                            </span>
                        </div>

                        <div className="ctx-stack" aria-hidden="true">
                            {ccSources
                                .filter((s) => s.index_tokens > 0)
                                .map((s) => (
                                    <span
                                        key={s.source}
                                        className={`ctx-stack-seg${sourceFilter === s.source ? " is-active" : ""}`}
                                        style={{
                                            flexGrow: s.index_tokens,
                                            background: hueMap.get(s.source),
                                        }}
                                        title={`${s.source} - ${fmtTokens(s.index_tokens)} index tokens`}
                                        onClick={() =>
                                            setSourceFilter((cur) =>
                                                cur === s.source ? null : s.source,
                                            )
                                        }
                                        role="button"
                                    />
                                ))}
                        </div>

                        <ul className="ctx-source-list">
                            {ccSources.map((s) => (
                                <li
                                    key={s.source}
                                    className={`ctx-source-row${sourceFilter === s.source ? " is-active" : ""}`}
                                    onClick={() =>
                                        setSourceFilter((cur) =>
                                            cur === s.source ? null : s.source,
                                        )
                                    }
                                >
                                    <span className="ctx-source-name">
                                        <i
                                            className="ctx-swatch"
                                            style={{ background: hueMap.get(s.source) }}
                                            aria-hidden="true"
                                        />
                                        {s.source}
                                    </span>
                                    <span className="ctx-source-skills">
                                        {fmtCount(s.skills)} {s.skills === 1 ? "skill" : "skills"}
                                    </span>
                                    <span className="ctx-source-bar" aria-hidden="true">
                                        <i
                                            style={{
                                                width: `${maxIndexSource > 0 ? Math.max(2, (s.index_tokens / maxIndexSource) * 100) : 0}%`,
                                                background: hueMap.get(s.source),
                                            }}
                                        />
                                    </span>
                                    <span className="ctx-source-index">
                                        {fmtTokens(s.index_tokens)}
                                        <small>always</small>
                                    </span>
                                    <span className="ctx-source-body">
                                        {fmtTokens(s.body_tokens)}
                                        <small>on demand</small>
                                    </span>
                                </li>
                            ))}
                        </ul>
                        {toolSources.length > 0 ? (
                            <p className="ctx-foot">
                                {toolSources.length} other-harness tool{" "}
                                {toolSources.length === 1 ? "catalog" : "catalogs"} (codex /
                                cursor / opencode / pi) excluded from the Claude Code session
                                budget.{" "}
                                <button
                                    type="button"
                                    className="ctx-link"
                                    onClick={() => setShowTools((v) => !v)}
                                >
                                    {showTools ? "hide" : "show"} in the index below
                                </button>
                            </p>
                        ) : null}
                    </section>

                    {/* --- SKILL INDEX: navigable, sortable, dense --- */}
                    <div className="inst-controls ctx-controls">
                        <button
                            type="button"
                            className={`inst-chip${sourceFilter === null ? " is-active" : ""}`}
                            onClick={() => setSourceFilter(null)}
                        >
                            all sources
                        </button>
                        {sourceFilter ? (
                            <span className="ctx-active-filter">
                                <i
                                    className="ctx-swatch"
                                    style={{ background: hueMap.get(sourceFilter) }}
                                    aria-hidden="true"
                                />
                                {sourceFilter}
                                <button
                                    type="button"
                                    className="ctx-link"
                                    onClick={() => setSourceFilter(null)}
                                >
                                    clear
                                </button>
                            </span>
                        ) : null}
                        <input
                            type="search"
                            placeholder="search name / source / scope   ( / focus · esc leave )"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="inst-search"
                            aria-label="search skills"
                            ref={searchRef}
                        />
                        <button
                            type="button"
                            className="inst-chip"
                            onClick={() => budget.refetch()}
                            disabled={refreshing}
                        >
                            {refreshing ? "refreshing…" : "refresh"}
                        </button>
                    </div>

                    <div className="inst-head-meta" style={{ margin: "0 0 10px" }}>
                        <b>{fmtCount(visibleSkills.length)}</b> in index
                        {hasMore ? (
                            <>
                                <span>·</span> showing {rendered.length}
                            </>
                        ) : null}
                    </div>

                    {visibleSkills.length === 0 ? (
                        <div className="empty">No skills match.</div>
                    ) : (
                        <table className="skills ctx-table" style={{ opacity: refreshing ? 0.6 : 1 }}>
                            <thead>
                                <tr>
                                    <SortHeader k="name" current={sortKey} dir={sortDir} onClick={onSortClick}>
                                        Skill
                                    </SortHeader>
                                    <SortHeader k="source" current={sortKey} dir={sortDir} onClick={onSortClick}>
                                        Source
                                    </SortHeader>
                                    <SortHeader k="index" current={sortKey} dir={sortDir} onClick={onSortClick} className="num">
                                        Index <span className="th-sub">always</span>
                                    </SortHeader>
                                    <SortHeader k="body" current={sortKey} dir={sortDir} onClick={onSortClick} className="num">
                                        Body <span className="th-sub">on demand</span>
                                    </SortHeader>
                                    <th className="num">Weight</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rendered.map((s) => (
                                    <SkillRow
                                        key={`${s.source}/${s.name}`}
                                        row={s}
                                        hue={hueMap.get(s.source) ?? "var(--dim)"}
                                        maxBody={maxBody}
                                    />
                                ))}
                            </tbody>
                        </table>
                    )}

                    {hasMore ? (
                        <div className="load-more">
                            <button
                                type="button"
                                onClick={() =>
                                    setRenderLimit((l) =>
                                        Math.min(l + RENDER_PAGE, visibleSkills.length),
                                    )
                                }
                            >
                                load {Math.min(RENDER_PAGE, visibleSkills.length - rendered.length)} more
                            </button>
                        </div>
                    ) : null}
                </>
            ) : null}
        </section>
    );
}

function SkillRow({
    row,
    hue,
    maxBody,
}: {
    row: ContextSkillRow;
    hue: string;
    maxBody: number;
}) {
    const frac = maxBody > 0 ? Math.max(0.02, row.body_tokens / maxBody) : 0;
    return (
        <tr className="skill-row">
            <td className="skill-cell">
                <strong>{row.name}</strong>
                {row.is_tool ? <span className="ctx-tool-tag">tool</span> : null}
            </td>
            <td>
                <span className="ctx-cell-source">
                    <i className="ctx-swatch" style={{ background: hue }} aria-hidden="true" />
                    {row.source}
                </span>
            </td>
            <td className="num">{fmtTokens(row.index_tokens)}</td>
            <td className="num">{fmtTokens(row.body_tokens)}</td>
            <td className="num">
                <span className="ctx-weight" aria-hidden="true">
                    <i style={{ width: `${frac * 100}%`, background: hue }} />
                </span>
            </td>
        </tr>
    );
}

function sortSkills(
    rows: ReadonlyArray<ContextSkillRow>,
    key: SortKey,
    dir: SortDir,
): ContextSkillRow[] {
    const out = rows.slice();
    out.sort((a, b) => {
        let cmp = 0;
        switch (key) {
            case "body":
                cmp = a.body_tokens - b.body_tokens;
                break;
            case "index":
                cmp = a.index_tokens - b.index_tokens;
                break;
            case "name":
                cmp = a.name.localeCompare(b.name);
                break;
            case "source":
                cmp = a.source.localeCompare(b.source) || b.body_tokens - a.body_tokens;
                break;
        }
        return dir === "desc" ? -cmp : cmp;
    });
    return out;
}

function SortHeader({
    k,
    current,
    dir,
    onClick,
    className,
    children,
}: {
    k: SortKey;
    current: SortKey;
    dir: SortDir;
    onClick: (k: SortKey) => void;
    className?: string;
    children: React.ReactNode;
}) {
    const active = k === current;
    const caret = active ? (dir === "desc" ? " ▾" : " ▴") : "";
    return (
        <th className={className}>
            <button
                type="button"
                onClick={() => onClick(k)}
                className={active ? "sort-header is-active" : "sort-header"}
            >
                {children}
                {caret}
            </button>
        </th>
    );
}
