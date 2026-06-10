/**
 * P2.2 / P3.7: ax session show - pure markdown formatter.
 *
 * No I/O, no Effect. Given a SessionShowPayload, returns a string ready for
 * process.stdout.write.
 *
 * P3.7 adds --by-role: when payload.by_role is populated, replaces the
 * "## Top skills" section with "## By role" grouped output.
 */

import type { SessionShowPayload } from "../dashboard/session-show.ts";
import type {
    SessionDetailPayload,
    SessionLink,
    SessionToolCall,
} from "@ax/lib/shared/dashboard-types";
import type { RevertedCommitDetail, SessionDurabilityDetail } from "../metrics/reverted-commits.ts";
import { renderByRoleSection } from "./role-format.ts";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";
import type { NavLink } from "@ax/lib/shared/nav-link";
import { renderNextFooter } from "./next-format.ts";

/** Optional enrichments rendered alongside the base session payload. */
export interface SessionShowExtras {
    /** Durability drill-down (#176): the commits behind durability_ratio.
     *  Null/undefined → no Metrics section rendered. */
    readonly metrics?: SessionDurabilityDetail | null;
    /** NavLink follow-ups (resume command, parent, expand-subagents).
     *  Rendered as a `next:` footer (markdown) / `next` field (JSON). */
    readonly next?: ReadonlyArray<NavLink>;
}

/** Last `n` hex chars of a UUID-like string, same pattern as cmdRecall. */
function shortId(id: string, n = 12): string {
    return id
        .replace(/^session:⟨/, "")
        .replace(/⟩$/, "")
        .replace(/^session:/, "")
        .slice(-n);
}

function fmtTs(ts: string | null | undefined): string {
    if (!ts) return "?";
    // Show HH:MM in local format from an ISO string
    try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return ts;
        return d.toISOString().slice(11, 16); // "HH:MM"
    } catch {
        return ts;
    }
}

function duration(startedAt: string | null | undefined, endedAt: string | null | undefined): string {
    if (!startedAt || !endedAt) return "?";
    try {
        const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
        if (ms < 0 || !Number.isFinite(ms)) return "?";
        const mins = Math.floor(ms / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        if (mins === 0) return `${secs}s`;
        if (secs === 0) return `${mins}m`;
        return `${mins}m${secs}s`;
    } catch {
        return "?";
    }
}

function count(value: number | null | undefined): string {
    return value == null ? "?" : Math.trunc(value).toLocaleString("en-US");
}

function money(value: number | null | undefined): string {
    return value == null ? "?" : `$${value.toFixed(4)}`;
}

function repoFromCwd(cwd: string | null | undefined): string {
    if (!cwd) return "?";
    const parts = cwd.split("/").filter((p) => p.length > 0);
    return parts[parts.length - 1] ?? "?";
}

/** Compact one-liner summary of a child session for the collapsed Subagents section. */
function formatChildOneLiner(child: SessionLink, delegation?: { description: string | null }): string {
    const sid = shortId(String(child.session_id));
    const desc = delegation?.description ?? child.nickname ?? null;
    const descPart = desc ? `  desc: "${desc.slice(0, 60)}"` : "";
    return `- ${sid}${descPart}`;
}

/** Format the tool_calls summary as "Tool×N" condensed items. */
function formatToolCallsBrief(tool_calls: ReadonlyArray<SessionToolCall>, maxItems = 5): string {
    return tool_calls
        .slice(0, maxItems)
        .map((t) => `${t.label}×${t.count}`)
        .join(" ");
}

/** Render timeline lines for a session's tool_calls (the unified stream). */
function renderTimeline(payload: SessionDetailPayload, prefix = ""): string[] {
    const lines: string[] = [];

    // tool_calls is a summary (label + count), not a per-event stream with
    // timestamps. The SessionDetailPayload does not include a per-event
    // stream in this fetch shape. We render what we have: the top tools and
    // agent delegation events.

    // Show top tools as summary items
    for (const tc of payload.tool_calls.slice(0, 8)) {
        const failures = tc.failures > 0 ? ` (${tc.failures} fail)` : "";
        lines.push(`${prefix}${tc.label.padEnd(22)}  ×${tc.count}${failures}`);
    }

    // Show agent delegations (spawn events) with rough timestamps
    for (const del of payload.agent_delegations) {
        const tsStr = del.ts ? fmtTs(del.ts) : "??:??";
        const sid = del.subagent_type ?? "subagent";
        const desc = del.description ? `  ${del.description.slice(0, 40)}` : "";
        lines.push(`${prefix}${tsStr}  Agent ->                ${sid}${desc}`);
    }

    return lines;
}

/** Short display sha: 7-char abbreviated sha, falling back to the commit
 *  record id tail when the sha column is empty. */
function shortSha(commit: { readonly sha: string | null; readonly commitId: string }): string {
    if (commit.sha) return commit.sha.slice(0, 7);
    const tail = commit.commitId.replace(/[`⟨⟩]/g, "").split(":").pop() ?? commit.commitId;
    return tail.slice(-12);
}

function fmtDay(ts: string | null): string {
    return ts ? ts.slice(0, 10) : "?";
}

function fmtPct(ratio: number | null): string {
    return ratio === null ? "-" : `${Math.round(ratio * 100)}%`;
}

/** Render caps: real sessions fan out hard (one mass-revert can carry dozens
 *  of fix edges and 100+ reverted commits) - cap the markdown block and point
 *  at --json for the full list. */
const MAX_REVERTED_SHOWN = 10;
const MAX_FIXES_SHOWN = 3;

function revertedCommitLines(commit: RevertedCommitDetail): string[] {
    const msg = (commit.message ?? "").split("\n")[0]!.slice(0, 72);
    const lines = [`- ${shortSha(commit)}  ${msg}  (${fmtDay(commit.ts)})`];
    if (commit.fixes.length === 0) {
        // commit.reverted is full-history but later_fixed_by is rebuilt
        // window-bounded - the fix exists, it just landed outside the window.
        lines.push("    fixed by: (outside ingest window - rerun a full `ax ingest` to link)");
        return lines;
    }
    for (const fix of commit.fixes.slice(0, MAX_FIXES_SHOWN)) {
        const fixMsg = (fix.message ?? "").split("\n")[0]!.slice(0, 64);
        const days = fix.daysBetween === null ? "" : ` +${fix.daysBetween.toFixed(1)}d`;
        const conf = fix.confidence ? ` · ${fix.confidence}` : "";
        lines.push(`    fixed by ${shortSha(fix)}  ${fixMsg}  (${fmtDay(fix.ts)}${days}${conf})`);
    }
    if (commit.fixes.length > MAX_FIXES_SHOWN) {
        lines.push(`    … and ${commit.fixes.length - MAX_FIXES_SHOWN} more fixing commits`);
    }
    return lines;
}

/**
 * Render the `## Metrics` durability drill-down (#176): the ratio plus the
 * actual commits that died and what replaced them. Returns [] when no detail
 * was provided, so callers can append unconditionally.
 */
function renderMetricsBlock(metrics: SessionDurabilityDetail | null | undefined): string[] {
    if (metrics === null || metrics === undefined) return [];
    const lines: string[] = ["## Metrics", ""];
    if (metrics.producedCommits === 0) {
        lines.push("durability  -  (session produced no commits)");
        return lines;
    }
    lines.push(
        `durability  ${fmtPct(metrics.durabilityRatio)}  ·  ${metrics.producedCommits} produced / ${metrics.revertedCommits} reverted`,
    );
    if (metrics.reverted.length > 0) {
        lines.push("reverted commits:");
        for (const commit of metrics.reverted.slice(0, MAX_REVERTED_SHOWN)) {
            lines.push(...revertedCommitLines(commit));
        }
        if (metrics.reverted.length > MAX_REVERTED_SHOWN) {
            lines.push(`… and ${metrics.reverted.length - MAX_REVERTED_SHOWN} more reverted commits (use --json for the full list)`);
        }
    }
    return lines;
}

/**
 * Render the `## Compaction` section listing context-compaction boundaries.
 * Returns "" when there are none, so callers can append unconditionally.
 */
function renderCompaction(payload: SessionShowPayload): string[] {
    const compactions = payload.compactions ?? [];
    if (compactions.length === 0) return [];
    const lines: string[] = [`## Compaction (${compactions.length})`, ""];
    for (const c of compactions) {
        const toks = c.tokens_before !== null ? ` · ${c.tokens_before} tok before` : "";
        const kept = c.kept_count !== null ? ` · ${c.kept_count} kept` : "";
        const sum = c.summary ? ` - ${c.summary.split("\n")[0]!.slice(0, 80)}` : "";
        lines.push(`- ${fmtTs(c.ts)} · ${c.harness} · ${c.strategy}${toks}${kept}${sum}`);
    }
    return lines;
}

/**
 * Render the session show payload as a markdown-flavoured TTY string.
 * Pure function - no I/O.
 */
export function renderSessionMarkdown(
    payload: SessionShowPayload,
    extras: SessionShowExtras = {},
): string {
    const { session } = payload;
    const expandedMap = new Map<string, SessionDetailPayload>();
    for (const sub of payload.expanded_subagents) {
        if (sub.overview) {
            const sid = String(sub.overview.id ?? "");
            expandedMap.set(sid, sub);
            // Also store stripped form for loose matching
            expandedMap.set(
                sid.replace(/^session:⟨/, "").replace(/⟩$/, "").replace(/^session:/, ""),
                sub,
            );
        }
    }

    const lines: string[] = [];
    const ov = session.overview;

    // ── header ───────────────────────────────────────────────────────────────
    const sid = ov ? shortId(String(ov.id)) : "unknown";
    lines.push(`# session ${sid}`);
    lines.push("");

    if (!ov) {
        lines.push("session not found");
        return lines.join("\n");
    }

    // ── overview ─────────────────────────────────────────────────────────────
    lines.push(
        `started   ${ov.started_at ?? "?"}  source ${ov.source ?? "?"}  project ${prettifyProjectSlug(ov.project ?? "")}`,
    );
    const dur = duration(ov.started_at, ov.ended_at);
    lines.push(`ended     ${ov.ended_at ?? "?"}  duration ${dur}`);
    if (session.token_usage) {
        const usage = session.token_usage;
        lines.push(
            `usage     model ${usage.model ?? ov.model ?? "?"}  tokens ${count(usage.estimated_tokens)}  cost ${money(usage.estimated_cost_usd)}`,
        );
        lines.push(
            `          prompt ${count(usage.prompt_tokens)}  output ${count(usage.completion_tokens)}  cache_write ${count(usage.cache_creation_input_tokens)}  cache_read ${count(usage.cache_read_input_tokens)}`,
        );
    }
    lines.push(
        `repo      ${repoFromCwd(ov.cwd).padEnd(20)} cwd ${ov.cwd ?? "?"}`,
    );
    const parentStr = session.parent
        ? `session ${shortId(String(session.parent.session_id))}`
        : "none";
    lines.push(`parent    ${parentStr}`);
    lines.push("");

    // ── metrics (durability drill-down, #176) ────────────────────────────────
    const metricsLines = renderMetricsBlock(extras.metrics);
    if (metricsLines.length > 0) {
        lines.push(...metricsLines);
        lines.push("");
    }

    // ── top skills / by-role ─────────────────────────────────────────────────
    if (payload.by_role !== null && payload.by_role !== undefined) {
        // P3.7: --by-role grouping replaces "## Top skills"
        lines.push(renderByRoleSection(payload.by_role));
        lines.push("");
    } else if (session.top_skills.length > 0) {
        lines.push("## Top skills");
        lines.push(`${"N".padStart(3)}  ${"skill".padEnd(30)} uses`);
        for (let i = 0; i < session.top_skills.length; i++) {
            const sk = session.top_skills[i]!;
            lines.push(`${String(i + 1).padStart(3)}  ${sk.skill.padEnd(30)} ${sk.count}`);
        }
        lines.push("");
    }

    // ── timeline ─────────────────────────────────────────────────────────────
    lines.push("## Timeline");

    const timelineLines = renderTimeline(session);
    for (const tl of timelineLines) {
        lines.push(tl);
    }

    // Insert expanded subagent timelines after their spawn points
    if (payload.expanded_subagents.length > 0) {
        lines.push("");
        lines.push("### Expanded subagent timelines");
        for (const sub of payload.expanded_subagents) {
            const subSid = sub.overview ? shortId(String(sub.overview.id)) : "unknown";
            lines.push(`#### ${subSid}`);
            const subLines = renderTimeline(sub, "  ");
            if (subLines.length === 0) {
                lines.push("  (no tool calls)");
            } else {
                lines.push(...subLines);
            }
        }
    }

    lines.push("");

    // ── compaction section ───────────────────────────────────────────────────
    const compactionLines = renderCompaction(payload);
    if (compactionLines.length > 0) {
        lines.push(...compactionLines);
        lines.push("");
    }

    // ── subagents section ────────────────────────────────────────────────────
    if (session.children.length > 0) {
        lines.push(`## Subagents (${session.children.length})`);
        for (const child of session.children) {
            // Find matching delegation for description
            const childSidStr = String(child.session_id);
            const expanded = expandedMap.get(childSidStr) ??
                expandedMap.get(childSidStr.replace(/^session:⟨/, "").replace(/⟩$/, "").replace(/^session:/, ""));

            if (expanded) {
                // Show expanded summary inline
                const toolSummary = formatToolCallsBrief(expanded.tool_calls);
                const desc = child.nickname ?? null;
                const descPart = desc ? `  desc: "${desc.slice(0, 50)}"` : "";
                lines.push(`- ${shortId(childSidStr)}  ${toolSummary}${descPart}  [expanded]`);
            } else {
                lines.push(formatChildOneLiner(child, { description: child.nickname }));
            }
        }
    }

    // ── next: footer (NavLinks - resume / parent / expand) ───────────────────
    if (extras.next && extras.next.length > 0) {
        const footer = renderNextFooter(extras.next);
        if (footer) lines.push(footer);
    }

    return lines.join("\n");
}

/**
 * Render the session show payload as compact JSON for piped/non-TTY output.
 * Emits the full fetchSessionDetail payload plus expanded_subagents array.
 * P3.7: includes by_role when populated.
 */
export function renderSessionJson(
    payload: SessionShowPayload,
    extras: SessionShowExtras = {},
): string {
    return JSON.stringify(
        {
            ...payload.session,
            expanded_subagents: payload.expanded_subagents,
            ...(payload.by_role !== null && payload.by_role !== undefined
                ? { by_role: payload.by_role }
                : {}),
            ...(extras.metrics !== null && extras.metrics !== undefined
                ? { metrics: extras.metrics }
                : {}),
            ...(extras.next !== undefined && extras.next.length > 0
                ? { next: extras.next }
                : {}),
        },
        null,
        2,
    );
}
