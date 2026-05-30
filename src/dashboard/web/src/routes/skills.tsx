import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";
import type {
    SkillDetailPayload,
    SkillSourcePayload,
    SkillTriageEntry,
    SkillTriageNote,
    SkillTriageResponse,
    TriageDecision,
} from "@shared/dashboard-types.ts";
import { fmtCount, fmtLastUsed, fmtScore, fmtTs } from "@shared/formatters.ts";
import { prettifyProjectSlug } from "@shared/project-slug.ts";

type Filter = "all" | "actionable" | "keep" | "archive" | "review";

type SortKey = "score" | "30d" | "7d" | "total" | "last" | "name";
type SortDir = "asc" | "desc";

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
    { key: "actionable", label: "Actionable" },
    { key: "review", label: "Review" },
    { key: "archive", label: "Archive" },
    { key: "keep", label: "Keep" },
    { key: "all", label: "All" },
];

const DEFAULT_DIR: Record<SortKey, SortDir> = {
    score: "desc",
    "30d": "desc",
    "7d": "desc",
    total: "desc",
    last: "desc",
    name: "asc",
};

const SKILL_RENDER_PAGE_SIZE = 80;

const filterByRecommendation = (
    rows: ReadonlyArray<SkillTriageEntry>,
    filter: Filter,
): ReadonlyArray<SkillTriageEntry> => {
    if (filter === "all") return rows;
    if (filter === "actionable") {
        return rows.filter(
            (r) => r.recommendation !== "keep" && r.decision === null,
        );
    }
    return rows.filter((r) => r.recommendation === filter);
};

const filterByScope = (
    rows: ReadonlyArray<SkillTriageEntry>,
    scope: string | null,
): ReadonlyArray<SkillTriageEntry> => {
    if (!scope || scope === "all") return rows;
    return rows.filter((r) => r.scope === scope);
};

const filterBySearch = (
    rows: ReadonlyArray<SkillTriageEntry>,
    query: string,
): ReadonlyArray<SkillTriageEntry> => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
        if (r.name.toLowerCase().includes(q)) return true;
        if (r.scope.toLowerCase().includes(q)) return true;
        if ((r.description ?? "").toLowerCase().includes(q)) return true;
        return false;
    });
};

const sortRows = (
    rows: ReadonlyArray<SkillTriageEntry>,
    key: SortKey,
    dir: SortDir,
): SkillTriageEntry[] => {
    const out = rows.slice();
    out.sort((a, b) => {
        let cmp = 0;
        switch (key) {
            case "score":
                cmp = a.taste_score - b.taste_score;
                break;
            case "30d":
                cmp = a.inv_30d - b.inv_30d;
                break;
            case "7d":
                cmp = a.inv_7d - b.inv_7d;
                break;
            case "total":
                cmp = a.total_inv - b.total_inv;
                break;
            case "last": {
                const ta = a.last_used ? Date.parse(a.last_used) : 0;
                const tb = b.last_used ? Date.parse(b.last_used) : 0;
                cmp = ta - tb;
                break;
            }
            case "name":
                cmp = a.name.localeCompare(b.name);
                break;
        }
        return dir === "desc" ? -cmp : cmp;
    });
    return out;
};

export function SkillsRoute() {
    const search0 = useSearch({ strict: false }) as { q?: string };
    const queryClient = useQueryClient();
    const skillsQuery = useQuery({
        queryKey: ["skills"],
        queryFn: () => api.skills(),
    });
    const data = skillsQuery.data ?? null;
    const [actionError, setError] = useState<string | null>(null);
    const error =
        actionError ?? (skillsQuery.error ? String(skillsQuery.error) : null);
    const loading = skillsQuery.isLoading;
    const refreshing = skillsQuery.isFetching && !skillsQuery.isLoading;
    const setData = (
        updater: (curr: SkillTriageResponse | null) => SkillTriageResponse | null,
    ) => {
        queryClient.setQueryData<SkillTriageResponse>(["skills"], (curr) => {
            const next = updater(curr ?? null);
            return next ?? curr;
        });
    };
    const [filter, setFilter] = useState<Filter>(search0.q ? "all" : "actionable");
    const [search, setSearch] = useState(search0.q ?? "");
    const [scope, setScope] = useState<string>("all");
    const [sortKey, setSortKey] = useState<SortKey>("score");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [renderLimit, setRenderLimit] = useState(SKILL_RENDER_PAGE_SIZE);
    const [lastSaved, setLastSaved] = useState<string | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [details, setDetails] = useState<Record<string, SkillDetailPayload>>({});
    const [sources, setSources] = useState<Record<string, SkillSourcePayload>>({});
    const [detailLoading, setDetailLoading] = useState<ReadonlySet<string>>(new Set());
    // Start at -1 so no row reads as "pre-selected for keyboard nav". First
    // j/k press promotes to 0.
    const [highlight, setHighlight] = useState(-1);
    const [showHelp, setShowHelp] = useState(false);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const tbodyRef = useRef<HTMLTableSectionElement | null>(null);

    const load = async (_mode: "initial" | "refresh" = "refresh") => {
        await skillsQuery.refetch();
    };

    const scopes = useMemo(() => {
        if (!data) return [] as string[];
        return Array.from(new Set(data.skills.map((s) => s.scope))).sort();
    }, [data]);

    const visible = useMemo(() => {
        if (!data) return [];
        return sortRows(
            filterBySearch(
                filterByScope(
                    filterByRecommendation(data.skills, filter),
                    scope,
                ),
                search,
            ),
            sortKey,
            sortDir,
        );
    }, [data, filter, scope, search, sortKey, sortDir]);

    const rendered = useMemo(
        () => visible.slice(0, renderLimit),
        [visible, renderLimit],
    );
    const hasMoreRows = rendered.length < visible.length;
    const renderedNames = useMemo(() => new Set(rendered.map((v) => v.name)), [rendered]);
    const selectedVisible = useMemo(
        () => Array.from(selected).filter((name) => renderedNames.has(name)),
        [selected, renderedNames],
    );

    const applyNote = (note: SkillTriageNote): void => {
        setData((curr) =>
            curr === null
                ? curr
                : {
                      ...curr,
                      skills: curr.skills.map((row) =>
                          row.name === note.skill_name ? { ...row, decision: note } : row,
                      ),
                  },
        );
    };

    const clearLocally = (name: string): void => {
        setData((curr) =>
            curr === null
                ? curr
                : {
                      ...curr,
                      skills: curr.skills.map((row) =>
                          row.name === name ? { ...row, decision: null } : row,
                      ),
                  },
        );
    };

    const flashSaved = (name: string) => {
        setLastSaved(name);
        window.setTimeout(() => {
            setLastSaved((curr) => (curr === name ? null : curr));
        }, 1200);
    };

    const decide = async (row: SkillTriageEntry, decision: TriageDecision) => {
        const alreadyActive = row.decision?.decision === decision;
        setPending(row.name);
        try {
            if (alreadyActive) {
                await api.clearDecision(row.name);
                clearLocally(row.name);
            } else {
                const note = await api.decide(row.name, decision);
                applyNote(note);
            }
            flashSaved(row.name);
            // A decision can flip the skill's on-disk state (archive disables
            // it, keep/review restores it). Refresh the open source panel so
            // the "disabled on disk" badge stays honest.
            if (expanded.has(row.name)) {
                try {
                    const s = await api.skillSource(row.name);
                    setSources((curr) => ({ ...curr, [row.name]: s }));
                } catch {
                    /* disk-state refresh is best-effort */
                }
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(null);
        }
    };

    const openSkill = async (name: string, target: "finder" | "editor") => {
        try {
            await api.openSkill(name, target);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const bulkDecide = async (decision: TriageDecision) => {
        if (selectedVisible.length === 0) return;
        setPending("__bulk__");
        try {
            const { notes } = await api.decideBulk(selectedVisible, decision);
            for (const note of notes) applyNote(note);
            setSelected(new Set());
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(null);
        }
    };

    const toggleSelected = (name: string) => {
        setSelected((curr) => {
            const next = new Set(curr);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    };

    const selectAllVisible = () => {
        setSelected(new Set(rendered.map((r) => r.name)));
    };

    const clearSelection = () => setSelected(new Set());

    const toggleExpanded = async (row: SkillTriageEntry) => {
        const isOpen = expanded.has(row.name);
        setExpanded((curr) => {
            const next = new Set(curr);
            if (isOpen) next.delete(row.name);
            else next.add(row.name);
            return next;
        });
        if (!isOpen && !details[row.name]) {
            setDetailLoading((curr) => new Set(curr).add(row.name));
            try {
                const [d, s] = await Promise.all([
                    api.detail(row.name),
                    api.skillSource(row.name),
                ]);
                setDetails((curr) => ({ ...curr, [row.name]: d }));
                setSources((curr) => ({ ...curr, [row.name]: s }));
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setDetailLoading((curr) => {
                    const next = new Set(curr);
                    next.delete(row.name);
                    return next;
                });
            }
        }
    };

    const onSortClick = (key: SortKey) => {
        if (key === sortKey) {
            setSortDir((d) => (d === "desc" ? "asc" : "desc"));
        } else {
            setSortKey(key);
            setSortDir(DEFAULT_DIR[key]);
        }
    };

    useEffect(() => {
        setRenderLimit(SKILL_RENDER_PAGE_SIZE);
    }, [filter, scope, search, sortKey, sortDir]);

    // Clamp highlight when the rendered set changes (filter/search/sort/load).
    useEffect(() => {
        if (rendered.length === 0) {
            if (highlight !== -1) setHighlight(-1);
            return;
        }
        if (highlight >= rendered.length) setHighlight(rendered.length - 1);
    }, [rendered, highlight]);

    // Scroll the highlighted row into view when keyboard navigation moves it.
    useEffect(() => {
        if (highlight < 0) return;
        const tbody = tbodyRef.current;
        if (!tbody) return;
        const row = tbody.children[highlight] as HTMLElement | undefined;
        row?.scrollIntoView({ block: "nearest" });
    }, [highlight]);

    // Global keybindings. Skip when the user is typing into a form field so
    // `/` doesn't double-fire and `j` doesn't move the row while filtering.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName ?? "";
            if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
                if (e.key === "Escape" && target instanceof HTMLInputElement) {
                    target.blur();
                }
                return;
            }
            if (e.metaKey || e.ctrlKey || e.altKey) return;

            switch (e.key) {
                case "/":
                    e.preventDefault();
                    searchRef.current?.focus();
                    return;
                case "?":
                    e.preventDefault();
                    setShowHelp((v) => !v);
                    return;
                case "j":
                    setHighlight((h) => Math.min(rendered.length - 1, h < 0 ? 0 : h + 1));
                    return;
                case "k":
                    setHighlight((h) => Math.max(0, h - 1));
                    return;
                case "g":
                    setHighlight(0);
                    return;
                case "G":
                    setHighlight(Math.max(0, rendered.length - 1));
                    return;
                case "r":
                    void load("refresh");
                    return;
                case "x": {
                    const row = rendered[highlight];
                    if (row) toggleSelected(row.name);
                    return;
                }
                case "1":
                case "2":
                case "3": {
                    const row = rendered[highlight];
                    if (!row) return;
                    const decision: TriageDecision =
                        e.key === "1" ? "keep" : e.key === "2" ? "review" : "archive";
                    void decide(row, decision);
                    return;
                }
                case "Enter": {
                    const row = rendered[highlight];
                    if (row) void toggleExpanded(row);
                    return;
                }
                default:
                    return;
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
        // load/decide/toggleExpanded/toggleSelected are stable enough; rendered
        // and highlight are the meaningful deps.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rendered, highlight]);

    const allVisibleSelected =
        rendered.length > 0 && rendered.every((r) => selected.has(r.name));

    const computeStats = (rows: ReadonlyArray<SkillTriageEntry>) => {
        let decided = 0;
        let keep = 0;
        let archive = 0;
        let review = 0;
        let actionable = 0;
        for (const row of rows) {
            if (row.decision) decided += 1;
            if (row.recommendation !== "keep" && row.decision === null) actionable += 1;
            switch (row.decision?.decision ?? row.recommendation) {
                case "keep":
                    keep += 1;
                    break;
                case "archive":
                    archive += 1;
                    break;
                case "review":
                    review += 1;
                    break;
            }
        }
        return { total: rows.length, decided, keep, archive, review, actionable };
    };

    // Global stats = progress meter across the full dataset. View stats =
    // breakdown for what's currently shown.
    const globalStats = useMemo(
        () => (data ? computeStats(data.skills) : null),
        [data],
    );
    const viewStats = useMemo(() => computeStats(visible), [visible]);

    return (
        <section className="panel">
            <header>
                <h2>Skill Triage</h2>
                <span className="meta">
                    {globalStats
                        ? `${globalStats.total} total · ${globalStats.decided} decided · ${globalStats.actionable} actionable`
                        : ""}
                    {data ? ` · generated ${fmtTs(data.generatedAt)}` : ""}
                </span>
            </header>
            {data ? (
                <div className="view-stats">
                    <span>
                        <strong>{visible.length}</strong> visible
                    </span>
                    {hasMoreRows ? (
                        <span>· showing {rendered.length}</span>
                    ) : null}
                    <span>· keep {viewStats.keep}</span>
                    <span>· review {viewStats.review}</span>
                    <span>· archive {viewStats.archive}</span>
                    {viewStats.decided > 0 ? (
                        <span>· {viewStats.decided} decided</span>
                    ) : null}
                </div>
            ) : null}

            <div className="actions toolbar">
                {FILTERS.map((f) => (
                    <button
                        key={f.key}
                        className={filter === f.key ? "is-active" : undefined}
                        onClick={() => setFilter(f.key)}
                        type="button"
                    >
                        {f.label}
                    </button>
                ))}
                <input
                    type="search"
                    placeholder="search name / scope / description  ( / focus · esc leave )"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="search"
                    aria-label="Search skills"
                    ref={searchRef}
                />
                <button
                    type="button"
                    onClick={() => setShowHelp((v) => !v)}
                    title="keyboard shortcuts (?)"
                    aria-label="keyboard shortcuts"
                    className="help-button"
                >
                    ? help
                </button>
                <button
                    onClick={() => load("refresh")}
                    type="button"
                    style={{ marginLeft: "auto" }}
                    disabled={refreshing}
                >
                    {refreshing ? "Refreshing…" : "Refresh"}
                </button>
            </div>

            {scopes.length > 1 ? (
                <div className="actions scope-bar">
                    <span className="scope-label">scope:</span>
                    <button
                        type="button"
                        className={scope === "all" ? "is-active" : undefined}
                        onClick={() => setScope("all")}
                    >
                        all
                    </button>
                    {scopes.map((s) => (
                        <button
                            key={s}
                            type="button"
                            className={scope === s ? "is-active" : undefined}
                            onClick={() => setScope(s)}
                        >
                            {s}
                        </button>
                    ))}
                </div>
            ) : null}

            {selectedVisible.length > 0 ? (
                <div className="bulk-bar">
                    <span>
                        <strong>{selectedVisible.length}</strong> selected
                    </span>
                    <div className="actions">
                        <button
                            type="button"
                            onClick={() => bulkDecide("keep")}
                            disabled={pending === "__bulk__"}
                        >
                            keep all
                        </button>
                        <button
                            type="button"
                            onClick={() => bulkDecide("review")}
                            disabled={pending === "__bulk__"}
                        >
                            review all
                        </button>
                        <button
                            type="button"
                            onClick={() => bulkDecide("archive")}
                            disabled={pending === "__bulk__"}
                        >
                            archive all
                        </button>
                        <button type="button" onClick={clearSelection}>
                            clear selection
                        </button>
                    </div>
                </div>
            ) : null}

            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}

            {data && visible.length === 0 && !loading ? (
                <div className="empty">No skills match.</div>
            ) : null}

            {showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null}

            {data && visible.length > 0 ? (
                <table
                    className="skills"
                    style={{ opacity: refreshing ? 0.6 : 1 }}
                >
                    <thead>
                        <tr>
                            <th style={{ width: 32 }}>
                                <input
                                    type="checkbox"
                                    aria-label="select loaded rows"
                                    checked={allVisibleSelected}
                                    onChange={() =>
                                        allVisibleSelected
                                            ? clearSelection()
                                            : selectAllVisible()
                                    }
                                />
                            </th>
                            <SortHeader k="name" current={sortKey} dir={sortDir} onClick={onSortClick}>
                                Skill
                            </SortHeader>
                            <th>Recommendation</th>
                            <SortHeader k="score" current={sortKey} dir={sortDir} onClick={onSortClick} className="num">
                                Score
                            </SortHeader>
                            <SortHeader k="30d" current={sortKey} dir={sortDir} onClick={onSortClick} className="num">
                                30d
                            </SortHeader>
                            <SortHeader k="7d" current={sortKey} dir={sortDir} onClick={onSortClick} className="num">
                                7d
                            </SortHeader>
                            <SortHeader k="total" current={sortKey} dir={sortDir} onClick={onSortClick} className="num">
                                total
                            </SortHeader>
                            <SortHeader k="last" current={sortKey} dir={sortDir} onClick={onSortClick} className="num">
                                last
                            </SortHeader>
                            <th>Decision</th>
                        </tr>
                    </thead>
                    <tbody ref={tbodyRef}>
                        {rendered.map((row, idx) => (
                            <SkillRowView
                                key={row.name}
                                row={row}
                                highlighted={idx === highlight}
                                justSaved={lastSaved === row.name}
                                pending={pending === row.name || pending === "__bulk__"}
                                selected={selected.has(row.name)}
                                expanded={expanded.has(row.name)}
                                detail={details[row.name] ?? null}
                                source={sources[row.name] ?? null}
                                detailLoading={detailLoading.has(row.name)}
                                onDecide={(d) => decide(row, d)}
                                onOpen={openSkill}
                                onToggleSelect={() => toggleSelected(row.name)}
                                onToggleExpand={() => toggleExpanded(row)}
                            />
                        ))}
                    </tbody>
                </table>
            ) : null}
            {data && hasMoreRows ? (
                <div className="load-more">
                    <button
                        type="button"
                        onClick={() =>
                            setRenderLimit((limit) =>
                                Math.min(limit + SKILL_RENDER_PAGE_SIZE, visible.length),
                            )
                        }
                    >
                        load {Math.min(SKILL_RENDER_PAGE_SIZE, visible.length - rendered.length)} more
                    </button>
                </div>
            ) : null}
        </section>
    );
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

function SkillRowView({
    row,
    highlighted,
    justSaved,
    pending,
    selected,
    expanded,
    detail,
    source,
    detailLoading,
    onDecide,
    onOpen,
    onToggleSelect,
    onToggleExpand,
}: {
    row: SkillTriageEntry;
    highlighted: boolean;
    justSaved: boolean;
    pending: boolean;
    selected: boolean;
    expanded: boolean;
    detail: SkillDetailPayload | null;
    source: SkillSourcePayload | null;
    detailLoading: boolean;
    onDecide: (decision: TriageDecision) => void;
    onOpen: (name: string, target: "finder" | "editor") => void;
    onToggleSelect: () => void;
    onToggleExpand: () => void;
}) {
    const decisionLabel = row.decision ? row.decision.decision : null;
    const trClasses = [
        "skill-row",
        highlighted ? "row-highlighted" : "",
        decisionLabel ? `row-decided row-decision-${decisionLabel}` : "",
        justSaved ? "row-just-saved" : "",
    ]
        .filter(Boolean)
        .join(" ");
    // Whole-row click toggles the accordion - but suppress when the user is
    // dragging a selection (so they can copy a skill name without expanding).
    const handleRowClick = () => {
        if ((window.getSelection()?.toString().length ?? 0) > 0) return;
        onToggleExpand();
    };
    // Anything with its own handler needs to stop the row click so the two
    // don't fight (checkbox toggle, decision buttons, the reason badge).
    const stop = (e: React.MouseEvent | React.ChangeEvent) => e.stopPropagation();
    return (
        <>
            <tr
                className={trClasses}
                onClick={handleRowClick}
                aria-expanded={expanded}
            >
                <td onClick={stop}>
                    <input
                        type="checkbox"
                        aria-label={`select ${row.name}`}
                        checked={selected}
                        onChange={onToggleSelect}
                        onClick={stop}
                    />
                </td>
                <td className="skill-cell">
                    <strong>{row.name}</strong>
                    <small>
                        <span className="chip">{row.scope}</span>
                        {row.description ? (
                            <span className="description" title={row.description}>
                                {row.description}
                            </span>
                        ) : null}
                    </small>
                </td>
                <td>
                    <div
                        className="reason-button"
                        title={expanded ? "click row to hide evidence" : "click row to show evidence"}
                    >
                        <span className={`badge ${row.recommendation}`}>
                            {row.recommendation}
                        </span>
                        <small>
                            {row.recommendation_reason} {expanded ? "▴" : "▾"}
                        </small>
                    </div>
                </td>
                <td className="num">{fmtScore(row.taste_score)}</td>
                <td className="num">{fmtCount(row.inv_30d)}</td>
                <td className="num">{fmtCount(row.inv_7d)}</td>
                <td className="num">{fmtCount(row.total_inv)}</td>
                <td className="num">{fmtLastUsed(row.last_used)}</td>
                <td onClick={stop}>
                    <div className="actions">
                        {(["keep", "review", "archive"] as TriageDecision[]).map((d) => (
                            <button
                                key={d}
                                type="button"
                                disabled={pending}
                                className={decisionLabel === d ? "is-active" : undefined}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDecide(d);
                                }}
                                title={
                                    decisionLabel === d
                                        ? "click to clear decision"
                                        : `mark as ${d}`
                                }
                            >
                                {d}
                            </button>
                        ))}
                    </div>
                    {row.decision ? (
                        <small>decided {fmtTs(row.decision.decided_at)}</small>
                    ) : null}
                </td>
            </tr>
            {expanded ? (
                <tr className="detail-row">
                    <td />
                    <td colSpan={8}>
                        <DetailPanel
                            detail={detail}
                            source={source}
                            loading={detailLoading}
                            onOpen={onOpen}
                        />
                    </td>
                </tr>
            ) : null}
        </>
    );
}

function DetailPanel({
    detail,
    source,
    loading,
    onOpen,
}: {
    detail: SkillDetailPayload | null;
    source: SkillSourcePayload | null;
    loading: boolean;
    onOpen: (name: string, target: "finder" | "editor") => void;
}) {
    if (loading && !detail) return <div className="loading">Loading evidence…</div>;
    if (!detail) return <div className="empty">No evidence yet.</div>;
    return (
        <div className="detail-grid">
            <div>
                <h3>Recent invocations</h3>
                {detail.recent.length === 0 ? (
                    <p className="empty">none</p>
                ) : (
                    <ul>
                        {detail.recent.map((r, i) => (
                            <li key={`${r.ts}-${i}`}>
                                <code>{fmtTs(r.ts)}</code>{" "}
                                <span>{prettifyProjectSlug(r.project)}</span>
                                {r.turn_has_error ? <span className="badge review">error</span> : null}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <div>
                <h3>Corrections ({detail.corrections.length})</h3>
                {detail.corrections.length === 0 ? (
                    <p className="empty">none - clean usage</p>
                ) : (
                    <ul>
                        {detail.corrections.map((r, i) => (
                            <li key={`${r.ts}-${i}`}>
                                <code>{fmtTs(r.ts)}</code>{" "}
                                <span>{prettifyProjectSlug(r.project)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <div>
                <h3>Proposals ({detail.proposals.length})</h3>
                {detail.proposals.length === 0 ? (
                    <p className="empty">none</p>
                ) : (
                    <ul>
                        {detail.proposals.map((p, i) => (
                            <li key={`${p.ts}-${i}`}>
                                <code>{fmtTs(p.ts)}</code>{" "}
                                <span>{prettifyProjectSlug(p.project)}</span>
                                {p.context_excerpt ? (
                                    <small>{p.context_excerpt}</small>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
                <h3>Frequently paired with ({detail.paired.length})</h3>
                {detail.paired.length === 0 ? (
                    <p className="empty">no co-occurring skills</p>
                ) : (
                    <ul className="paired-list">
                        {detail.paired.map((p) => (
                            <li key={p.partner}>
                                <Link to="/skills" search={{ q: p.partner }}>
                                    <strong>{p.partner}</strong>
                                </Link>
                                <span className="chip">{p.count}x</span>
                                <small>last {fmtLastUsed(p.last_seen)}</small>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
                <h3>Skill source</h3>
                <SkillSourceView source={source} onOpen={onOpen} />
            </div>
        </div>
    );
}

const SOURCE_STATE_LABEL: Record<string, string> = {
    active: "active",
    disabled: "disabled on disk",
    missing: "no file",
};

function SkillSourceView({
    source,
    onOpen,
}: {
    source: SkillSourcePayload | null;
    onOpen: (name: string, target: "finder" | "editor") => void;
}) {
    if (!source) return <div className="loading">Loading source…</div>;

    const stateBadge =
        source.state === "active" ? "keep"
        : source.state === "disabled" ? "archive"
        : "review";

    return (
        <div className="skill-source">
            <div className="skill-source-head">
                <span className={`badge ${stateBadge}`}>
                    {SOURCE_STATE_LABEL[source.state] ?? source.state}
                </span>
                <span className="chip">{source.scope}</span>
                {source.file_path ? (
                    <code className="skill-source-path">{source.file_path}</code>
                ) : (
                    <small className="empty">
                        no on-disk SKILL.md (synthetic / built-in skill)
                    </small>
                )}
            </div>

            {source.error ? (
                <div className="error">Could not read file: {source.error}</div>
            ) : null}

            {source.file_path ? (
                <div className="actions skill-source-actions">
                    <button
                        type="button"
                        onClick={() => onOpen(source.name, "editor")}
                    >
                        Open in editor
                    </button>
                    <button
                        type="button"
                        onClick={() => onOpen(source.name, "finder")}
                    >
                        Reveal in Finder
                    </button>
                    {!source.editable ? (
                        <small className="empty">
                            read-only - {source.scope} skills are not disk-editable;
                            decisions stay labels only
                        </small>
                    ) : source.state === "disabled" ? (
                        <small className="empty">
                            disabled - mark “keep” or “review” to restore it
                        </small>
                    ) : (
                        <small className="empty">
                            marking “archive” renames SKILL.md so the agent stops
                            loading it
                        </small>
                    )}
                </div>
            ) : null}

            {source.frontmatter ? (
                <>
                    <h4>Frontmatter</h4>
                    <pre className="skill-source-block skill-source-frontmatter">
                        {source.frontmatter}
                    </pre>
                </>
            ) : null}

            {source.body ? (
                <>
                    <h4>SKILL.md body</h4>
                    <pre className="skill-source-block skill-source-body">
                        {source.body}
                    </pre>
                </>
            ) : source.file_path && !source.error ? (
                <p className="empty">empty body</p>
            ) : null}
        </div>
    );
}

const SHORTCUTS: ReadonlyArray<{ keys: string; what: string }> = [
    { keys: "/", what: "focus search" },
    { keys: "esc", what: "leave search" },
    { keys: "j / k", what: "move row down / up" },
    { keys: "g / G", what: "jump top / bottom" },
    { keys: "Enter", what: "expand evidence" },
    { keys: "x", what: "toggle row selection" },
    { keys: "1 / 2 / 3", what: "keep / review / archive" },
    { keys: "r", what: "refresh" },
    { keys: "?", what: "toggle this help" },
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
    return (
        <div className="help-overlay" onClick={onClose}>
            <div className="help-card" onClick={(e) => e.stopPropagation()}>
                <header>
                    <h3>Keyboard shortcuts</h3>
                    <button type="button" onClick={onClose} aria-label="close help">
                        ×
                    </button>
                </header>
                <dl>
                    {SHORTCUTS.map((s) => (
                        <div key={s.keys}>
                            <dt>
                                <kbd>{s.keys}</kbd>
                            </dt>
                            <dd>{s.what}</dd>
                        </div>
                    ))}
                </dl>
            </div>
        </div>
    );
}
