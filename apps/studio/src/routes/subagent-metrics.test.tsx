import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { compactTokens, fmtDurationMs, subagentMetricChips } from "./session-inspect.tsx";
import { ShareSpawnMarker, type ShareSubagentCard } from "./share-inspect.tsx";

describe("compactTokens", () => {
    test("compacts >=1000 to one-decimal k", () => {
        expect(compactTokens(30_300)).toBe("30.3k");
        expect(compactTokens(1000)).toBe("1.0k");
    });
    test("passes through <1000 verbatim", () => {
        expect(compactTokens(156)).toBe("156");
        expect(compactTokens(1)).toBe("1");
    });
    test("returns null for empty / non-positive / nullish", () => {
        expect(compactTokens(0)).toBeNull();
        expect(compactTokens(-5)).toBeNull();
        expect(compactTokens(null)).toBeNull();
        expect(compactTokens(undefined)).toBeNull();
        expect(compactTokens(Number.NaN)).toBeNull();
    });
});

describe("fmtDurationMs", () => {
    test("<60s renders seconds", () => {
        expect(fmtDurationMs(42_000)).toBe("42s");
        expect(fmtDurationMs(0)).toBe("0s");
    });
    test("<60m renders m+s, dropping a zero seconds remainder", () => {
        expect(fmtDurationMs(118_000)).toBe("1m58s");
        expect(fmtDurationMs(120_000)).toBe("2m");
    });
    test(">=60m renders h+m, dropping a zero minutes remainder", () => {
        expect(fmtDurationMs(3_720_000)).toBe("1h2m");
        expect(fmtDurationMs(3_600_000)).toBe("1h");
    });
    test("returns null for negative / nullish", () => {
        expect(fmtDurationMs(-1)).toBeNull();
        expect(fmtDurationMs(null)).toBeNull();
        expect(fmtDurationMs(undefined)).toBeNull();
    });
});

describe("subagentMetricChips", () => {
    test("orders turns · tools · tok · duration · cost and omits nulls", () => {
        const chips = subagentMetricChips({
            turns: 42,
            tool_calls: 14,
            est_tokens: 30_300,
            duration_ms: 118_000,
            cost_usd: 0.15,
        });
        expect(chips).toEqual(["42 turns", "14 tools", "30.3k tok", "1m58s", "$0.15"]);
    });
    test("omits any null metric", () => {
        expect(
            subagentMetricChips({
                turns: 3,
                tool_calls: null,
                est_tokens: null,
                duration_ms: null,
                cost_usd: null,
            }),
        ).toEqual(["3 turns"]);
    });
    test("all null yields an empty chip list", () => {
        expect(
            subagentMetricChips({
                turns: null,
                tool_calls: null,
                est_tokens: null,
                duration_ms: null,
                cost_usd: null,
            }),
        ).toEqual([]);
    });
    test("sub-cent cost gets 4-decimal formatting", () => {
        const chips = subagentMetricChips({
            turns: null,
            tool_calls: null,
            est_tokens: null,
            duration_ms: null,
            cost_usd: 0.0042,
        });
        expect(chips).toEqual(["$0.0042"]);
    });
});

const card = (over: Partial<ShareSubagentCard> = {}): ShareSubagentCard => ({
    id: "child-abc123",
    file: "subagent-child.json",
    parent_id: "root",
    depth: 1,
    spawn_turn_seq: 7,
    source: "claude",
    model: "claude-opus",
    duration_ms: 118_000,
    stats: { turns: 42, tool_calls: 14, files_changed: 2, skills_used: 1, failures: 0 },
    cost_usd: 0.15,
    estimated_tokens: 30_300,
    task_label: "do the thing",
    had_error: false,
    ...over,
});

describe("ShareSpawnMarker", () => {
    test("renders the full metric set (turns, tools, tok, duration, cost)", () => {
        const html = renderToStaticMarkup(
            <ShareSpawnMarker card={card()} onSelect={() => {}} onPrefetch={() => {}} />,
        );
        expect(html).toContain("42 turns");
        expect(html).toContain("14 tools");
        expect(html).toContain("30.3k tok");
        // share path uses its own fmtDuration (spaced variant)
        expect(html).toContain("1m 58s");
        expect(html).toContain("$0.15");
    });

    test("omits null tokens / duration / cost chips", () => {
        const html = renderToStaticMarkup(
            <ShareSpawnMarker
                card={card({ estimated_tokens: null, duration_ms: null, cost_usd: null })}
                onSelect={() => {}}
                onPrefetch={() => {}}
            />,
        );
        // turns + tools always present (from stats counts)
        expect(html).toContain("42 turns");
        expect(html).toContain("14 tools");
        // nulled metrics omitted
        expect(html).not.toContain("tok");
        expect(html).not.toContain("$");
    });
});
