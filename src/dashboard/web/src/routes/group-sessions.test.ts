import { describe, expect, test } from "bun:test";
import type { SessionListRow } from "../../../../lib/shared/dashboard-types.ts";
import { groupByParent } from "./group-sessions.ts";

const row = (id: string, parent: string | null = null, extra: Partial<SessionListRow> = {}): SessionListRow => ({
    id,
    project: null,
    source: "codex",
    cwd: null,
    model: null,
    started_at: extra.started_at ?? "2026-05-15T09:00:00.000Z",
    ended_at: null,
    has_raw_file: true,
    turn_count: 0,
    parent_session: parent,
    ...extra,
});

describe("groupByParent", () => {
    test("top-level rows with no parent stay top-level", () => {
        const rows = [row("session:a"), row("session:b")];
        const g = groupByParent(rows);
        expect(g.topLevel.map((r) => r.id)).toEqual(["session:a", "session:b"]);
        expect(g.childrenByParent.size).toBe(0);
    });

    test("in-window subagents nest under parent", () => {
        const rows = [
            row("session:parent"),
            row("session:c1", "session:parent", { started_at: "2026-05-15T09:00:02Z" }),
            row("session:c2", "session:parent", { started_at: "2026-05-15T09:00:01Z" }),
        ];
        const g = groupByParent(rows);
        expect(g.topLevel.map((r) => r.id)).toEqual(["session:parent"]);
        const kids = g.childrenByParent.get("session:parent");
        expect(kids?.map((r) => r.id)).toEqual(["session:c2", "session:c1"]); // sorted by started_at ASC
    });

    test("out-of-window parent: child stays top-level when no stub provided (regression baseline)", () => {
        const rows = [row("session:orphan", "session:missing-parent")];
        const g = groupByParent(rows);
        expect(g.topLevel.map((r) => r.id)).toEqual(["session:orphan"]);
        expect(g.childrenByParent.size).toBe(0);
    });

    test("out-of-window parent: hydrated stub enables grouping", () => {
        const rows = [
            row("session:c1", "session:missing-parent"),
            row("session:c2", "session:missing-parent"),
        ];
        const stubs = [row("session:missing-parent", null, { is_stub: true })];
        const g = groupByParent(rows, stubs);
        expect(g.topLevel.map((r) => r.id)).toEqual(["session:missing-parent"]);
        const kids = g.childrenByParent.get("session:missing-parent");
        expect(kids?.map((r) => r.id)).toEqual(["session:c1", "session:c2"]);
        // Stub flag preserved so the SPA can render it muted
        expect(g.topLevel[0]?.is_stub).toBe(true);
    });

    test("stub is ignored when the parent is already a real in-window row", () => {
        const rows = [
            row("session:parent"),
            row("session:c1", "session:parent"),
        ];
        const stubs = [row("session:parent", null, { is_stub: true })];
        const g = groupByParent(rows, stubs);
        // Real row wins; stub does not get re-added as a duplicate top-level entry.
        expect(g.topLevel.length).toBe(1);
        expect(g.topLevel[0]?.id).toBe("session:parent");
        expect(g.topLevel[0]?.is_stub).toBeUndefined();
    });

    test("mixed: orphans + grouped + stub-grouped coexist", () => {
        const rows = [
            row("session:p1"),                                    // real parent in window
            row("session:p1c", "session:p1"),                     // nests under p1
            row("session:loose", "session:not-in-window-nor-stub"), // stays top-level (no stub)
            row("session:s1c", "session:stub-parent"),            // will nest under stub
        ];
        const stubs = [row("session:stub-parent", null, { is_stub: true })];
        const g = groupByParent(rows, stubs);
        const topIds = g.topLevel.map((r) => r.id).sort();
        expect(topIds).toEqual(["session:loose", "session:p1", "session:stub-parent"].sort());
        expect(g.childrenByParent.get("session:p1")?.map((r) => r.id)).toEqual(["session:p1c"]);
        expect(g.childrenByParent.get("session:stub-parent")?.map((r) => r.id)).toEqual(["session:s1c"]);
    });
});
