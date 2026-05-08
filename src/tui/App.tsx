import { useEffect, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { SurrealClientShape } from "../lib/db.ts";
import { useSkills, type SkillRow } from "./hooks/useSkills.ts";
import { useSkillDetail } from "./hooks/useSkillDetail.ts";
import { useLiveInvocations } from "./hooks/useLiveInvocations.ts";
import { SearchBar } from "./SearchBar.tsx";
import { SkillList, type SortKey } from "./SkillList.tsx";
import { DetailPane } from "./DetailPane.tsx";
import { StatusBar } from "./StatusBar.tsx";

const SORT_CYCLE: ReadonlyArray<SortKey> = [
    "taste_score",
    "inv_30d",
    "inv_7d",
    "total_inv",
    "last_used",
    "name",
];

const sortRows = (
    rows: ReadonlyArray<SkillRow>,
    key: SortKey,
    reversed: boolean,
): SkillRow[] => {
    const copy = rows.slice();
    copy.sort((a, b) => {
        if (key === "name") return a.name.localeCompare(b.name);
        if (key === "last_used") {
            const ta = a.last_used ? Date.parse(a.last_used) : 0;
            const tb = b.last_used ? Date.parse(b.last_used) : 0;
            return tb - ta;
        }
        return Number(b[key] ?? 0) - Number(a[key] ?? 0);
    });
    if (reversed) copy.reverse();
    return copy;
};

const filterRows = (
    rows: ReadonlyArray<SkillRow>,
    query: string,
): ReadonlyArray<SkillRow> => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
        if (r.name.toLowerCase().includes(q)) return true;
        if (r.scope.toLowerCase().includes(q)) return true;
        const desc = (r.description ?? "").toLowerCase();
        if (desc.includes(q)) return true;
        return false;
    });
};

interface AppProps {
    readonly client: SurrealClientShape;
    readonly onQuit: () => void;
}

/**
 * Top-level dashboard component. Owns query/selection/sort state. Splits
 * keyboard input between "list mode" (navigate, sort, quit) and "search
 * mode" (typing a filter). The Input renderable receives focus when we're
 * in search mode; otherwise the list takes our keystrokes.
 */
export function App({ client, onQuit }: AppProps) {
    const liveTick = useLiveInvocations(client);
    const skills = useSkills(client);

    // Re-fetch the list whenever live tick advances.
    useEffect(() => {
        if (liveTick > 0) skills.refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [liveTick]);

    const [query, setQuery] = useState("");
    const [mode, setMode] = useState<"list" | "search">("list");
    const [sortKey, setSortKey] = useState<SortKey>("taste_score");
    const [reversed, setReversed] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);

    const visibleRows = useMemo(
        () => sortRows(filterRows(skills.data, query), sortKey, reversed),
        [skills.data, query, sortKey, reversed],
    );

    // Clamp selection into range when row count changes.
    useEffect(() => {
        if (visibleRows.length === 0) {
            if (selectedIndex !== 0) setSelectedIndex(0);
            return;
        }
        if (selectedIndex >= visibleRows.length) {
            setSelectedIndex(visibleRows.length - 1);
        }
    }, [visibleRows, selectedIndex]);

    const selectedSkill = visibleRows[selectedIndex] ?? null;
    const detail = useSkillDetail(client, selectedSkill?.name ?? null, liveTick);

    useKeyboard((key) => {
        // Search mode: only intercept escape; let the input handle everything else.
        if (mode === "search") {
            if (key.name === "escape") {
                setMode("list");
            } else if (key.name === "return" || key.name === "enter") {
                setMode("list");
            }
            return;
        }

        // List mode hotkeys.
        switch (key.name) {
            case "q":
                onQuit();
                return;
            case "up":
            case "k":
                setSelectedIndex((i) => Math.max(0, i - 1));
                return;
            case "down":
            case "j":
                setSelectedIndex((i) =>
                    Math.min(Math.max(0, visibleRows.length - 1), i + 1),
                );
                return;
            case "g":
                setSelectedIndex(0);
                return;
            case "G":
                setSelectedIndex(Math.max(0, visibleRows.length - 1));
                return;
            case "s": {
                const nextIdx =
                    (SORT_CYCLE.indexOf(sortKey) + 1) % SORT_CYCLE.length;
                const next = SORT_CYCLE[nextIdx];
                if (next) setSortKey(next);
                return;
            }
            case "r":
                setReversed((v) => !v);
                return;
            case "/":
                setMode("search");
                return;
            case "escape":
                if (query) {
                    setQuery("");
                    setSelectedIndex(0);
                }
                return;
            default:
                return;
        }
    });

    const dbError = skills.error;
    const errorMessage = dbError
        ? dbError.includes("ECONNREFUSED") || dbError.includes("connect")
            ? "DB not running - start with `bun run db:start`"
            : `DB error: ${dbError}`
        : null;

    return (
        <box style={{ flexDirection: "column", flexGrow: 1, padding: 1 }}>
            <SearchBar
                value={query}
                onChange={setQuery}
                focused={mode === "search"}
            />
            <box style={{ flexDirection: "row", flexGrow: 1, gap: 1 }}>
                <box style={{ width: 70, flexShrink: 0, flexGrow: 0 }}>
                    <SkillList
                        rows={visibleRows}
                        selectedIndex={selectedIndex}
                        sortKey={sortKey}
                        reversed={reversed}
                        loading={skills.loading}
                        emptyMessage={
                            errorMessage
                                ? errorMessage
                                : query
                                  ? "No skills match"
                                  : "No skills indexed yet - run `agentctl ingest`"
                        }
                    />
                </box>
                <box style={{ flexGrow: 1 }}>
                    <DetailPane
                        data={detail.data}
                        loading={detail.loading}
                        error={detail.error}
                        empty={selectedSkill === null}
                    />
                </box>
            </box>
            <StatusBar
                count={visibleRows.length}
                total={skills.data.length}
                mode={mode}
                error={errorMessage}
            />
        </box>
    );
}
