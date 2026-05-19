/**
 * Pure helper: nest subagent session rows under their parent for the
 * `/sessions` list view. Server hydrates "parent stubs" for parents whose
 * children appear in the page window but the parent itself does not; we
 * merge stubs into the rows so grouping works across page boundaries.
 *
 * Kept module-local so it can be unit-tested without React.
 */

import type { SessionListRow } from "../../../../lib/shared/dashboard-types.ts";

export interface Grouped {
    readonly topLevel: ReadonlyArray<SessionListRow>;
    readonly childrenByParent: ReadonlyMap<string, ReadonlyArray<SessionListRow>>;
}

export function groupByParent(
    rows: ReadonlyArray<SessionListRow>,
    parentStubs: ReadonlyArray<SessionListRow> = [],
): Grouped {
    // Merge in stubs, but only those whose id isn't already present in `rows`
    // (defensive: a stub from a prior page may have already arrived via the
    // main window).
    const presentIds = new Set(rows.map((r) => r.id));
    const merged: SessionListRow[] = [...rows];
    for (const stub of parentStubs) {
        if (!presentIds.has(stub.id)) {
            merged.push(stub);
            presentIds.add(stub.id);
        }
    }

    const topLevel: SessionListRow[] = [];
    const childrenByParent = new Map<string, SessionListRow[]>();
    for (const r of merged) {
        // A row nests under its parent when (a) it has a parent_session and
        // (b) that parent is in the merged set (real row OR hydrated stub).
        // Otherwise it stays top-level so it's still visible.
        if (r.parent_session && presentIds.has(r.parent_session)) {
            const list = childrenByParent.get(r.parent_session) ?? [];
            list.push(r);
            childrenByParent.set(r.parent_session, list);
        } else {
            topLevel.push(r);
        }
    }
    // Sort children by started_at ASC so subagents read top→bottom in spawn order.
    for (const list of childrenByParent.values()) {
        list.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
    }
    return { topLevel, childrenByParent };
}
