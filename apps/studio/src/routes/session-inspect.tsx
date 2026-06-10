import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "../api.ts";
import type { HookFireDto, InspectSpanDto, InspectSpanKind, InspectTurnDto, SessionInspectPayload, SessionTokenUsageDetail, TurnTokenUsageDetail } from "@ax/lib/shared/dashboard-types";
import { childrenByAnchorTurn, spawnAnchorSet, turnText } from "./inspector-filters.ts";
import { spliceHookFires } from "@ax/lib/shared/hook-fire-splice";
import { FilterBar } from "./inspector-filter-bar.tsx";
import { SessionTimelineView } from "./session-timeline.tsx";
import { shortSessionId } from "@ax/lib/shared/session-id";
import { sessionProjectLabel } from "@ax/lib/shared/project-slug";
import { ToolResultView } from "./tool-result.tsx";
import { ToolRow } from "./tool-row.tsx";
import { extractImagePaths } from "./turn-images.ts";
import { TurnImages } from "./turn-images.tsx";
import { Transcript } from "./transcript.tsx";
import type { InspectContentAtomDto, InspectContentBlockDto, InspectTurnContentDto } from "@ax/lib/shared/dashboard-types";

interface KindStyle { bg: string; fg: string; bar: string; label: string }

/** One tone recipe off the calibrated root accents: tinted bg, ink-anchored
 *  dark fg (always readable on the tint), the raw accent as the bar. Two
 *  kinds in the same family differ by bg strength (call 14% vs result 7%). */
const tone = (accent: string, bgPct: number, label: string): KindStyle => ({
    bg: `color-mix(in srgb, ${accent} ${bgPct}%, var(--panel))`,
    fg: `color-mix(in srgb, ${accent} 45%, var(--ink))`,
    bar: accent,
    label,
});

export const KIND_STYLE: Record<InspectSpanKind, KindStyle> = {
    user_input:            tone("var(--gold)", 12, "user input"),
    assistant_text:        { bg: "var(--track)", fg: "var(--ink)", bar: "var(--ink)", label: "assistant text" },
    tool_use:              tone("var(--violet)", 14, "tool use"),
    skill_context:         tone("var(--blue)", 12, "skill"),
    system_context:        { bg: "var(--track)", fg: "var(--ink)", bar: "var(--muted)", label: "system" },
    wrapper_instruction:   tone("var(--gold)", 26, "wrapper"),
    hook_injection:        tone("var(--green)", 14, "hook"),
    tool_result:           tone("var(--violet)", 7, "tool result"),
    subagent_notification: tone("var(--rose)", 7, "subagent notif"),
    subagent_task:         tone("var(--rose)", 14, "subagent task"),
    pasted_reference:      tone("var(--red)", 12, "pasted"),
};

const JUMP_TARGET_SCROLL_MARGIN = 76;

export function Span({ span }: { span: InspectSpanDto }) {
    const s = KIND_STYLE[span.kind];
    const title = span.label ? `${s.label}: ${span.label}` : s.label;
    return (
        <span style={{ background: s.bg, color: s.fg, padding: "0 1px", borderRadius: 2 }} title={title}>
            {span.text}
        </span>
    );
}

type ContentTone = { bg: string; fg: string; bar: string; label: string };

const ALIAS_STYLE: Record<string, ContentTone> = {
    objective:             { bg: "#dcfce7", fg: "#166534", bar: "#22c55e", label: "objective" },
    budget:                { bg: "#ffedd5", fg: "#9a3412", bar: "#f97316", label: "budget" },
    continuation_behavior: { bg: "#fef3c7", fg: "#854d0e", bar: "#eab308", label: "continuation" },
    completion_audit:      { bg: "#fee2e2", fg: "#991b1b", bar: "#ef4444", label: "completion audit" },
    progress_visibility:   { bg: "#dbeafe", fg: "#1e3a8a", bar: "var(--blue)", label: "progress" },
    work_from_evidence:    { bg: "#ccfbf1", fg: "#115e59", bar: "#14b8a6", label: "evidence" },
    environment_context:   { bg: "#e0f2fe", fg: "#075985", bar: "#0284c7", label: "environment" },
    permissions:           { bg: "#e5e7eb", fg: "#1f2937", bar: "var(--muted)", label: "permissions" },
    agent_guidance:        { bg: "#f5f3ff", fg: "#5b21b6", bar: "#8b5cf6", label: "agent guidance" },
    skills_manifest:       { bg: "#dbeafe", fg: "#1e3a8a", bar: "var(--blue)", label: "skills" },
    apps_manifest:         { bg: "#ecfccb", fg: "#3f6212", bar: "#84cc16", label: "apps" },
    plugins_manifest:      { bg: "#fce7f3", fg: "#9d174d", bar: "#ec4899", label: "plugins" },
    tool_call:             { bg: "#ede9fe", fg: "#4c1d95", bar: "#8b5cf6", label: "tool call" },
    tool_output:           { bg: "#e9d5ff", fg: "#5b21b6", bar: "#a855f7", label: "tool output" },
    plan:                  { bg: "#cffafe", fg: "#155e75", bar: "#06b6d4", label: "plan" },
    todo:                  { bg: "#fef9c3", fg: "#713f12", bar: "#ca8a04", label: "todo" },
    verification:          { bg: "#dcfce7", fg: "#14532d", bar: "#16a34a", label: "verification" },
    reference:             { bg: "var(--track)", fg: "var(--ink)", bar: "var(--muted)", label: "reference" },
};

const numberOrNull = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

const fmtCount = (value: number | null | undefined): string =>
    numberOrNull(value)?.toLocaleString() ?? "-";

const fmtUsd = (value: number | null | undefined): string => {
    const n = numberOrNull(value);
    if (n === null) return "-";
    if (n === 0) return "$0";
    if (n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(2)}`;
};

const pctOf = (part: number | null | undefined, total: number | null | undefined): string => {
    const p = numberOrNull(part);
    const t = numberOrNull(total);
    if (p === null || t === null || t <= 0) return "-";
    return `${((p / t) * 100).toFixed(1)}%`;
};

export function estimateCharWeightedCost(
    totalCost: number | null | undefined,
    totalChars: number,
    chars: number,
): number | null {
    const cost = numberOrNull(totalCost);
    if (cost === null || totalChars <= 0 || chars <= 0) return null;
    return cost * (chars / totalChars);
}

function tokenCostTotal(usage: SessionTokenUsageDetail | null): number | null {
    return numberOrNull(usage?.estimated_cost_usd);
}

function totalBreakdownCost(usage: SessionTokenUsageDetail): number {
    const parts: ReadonlyArray<number | null | undefined> = [
        usage.estimated_input_cost_usd,
        usage.estimated_cache_creation_cost_usd,
        usage.estimated_cache_read_cost_usd,
        usage.estimated_output_cost_usd,
    ];
    return parts.reduce<number>((sum, value) => sum + (numberOrNull(value) ?? 0), 0);
}

function costBarSegments(usage: SessionTokenUsageDetail): ReadonlyArray<{ label: string; value: number | null; color: string }> {
    return [
        { label: "fresh input", value: numberOrNull(usage.estimated_input_cost_usd), color: "var(--blue)" },
        { label: "cache write", value: numberOrNull(usage.estimated_cache_creation_cost_usd), color: "var(--gold)" },
        { label: "cache read", value: numberOrNull(usage.estimated_cache_read_cost_usd), color: "var(--green)" },
        { label: "output", value: numberOrNull(usage.estimated_output_cost_usd), color: "var(--violet)" },
    ];
}

/** Compact, glanceable token count for the turn header: `43.3k` / `156`.
 *  The full fresh/cache/output breakdown lives in the hover title only. */
function compactTokenCount(usage: TurnTokenUsageDetail): string | null {
    const n = numberOrNull(usage.estimated_tokens);
    if (n === null || n <= 0) return null;
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

type CostProgress = {
    seq: number | null;
    exactTurns: number;
    estimatedTokens: number;
    totalCostUsd: number;
    freshInputCostUsd: number;
    cacheWriteCostUsd: number;
    cacheReadCostUsd: number;
    outputCostUsd: number;
};

const EMPTY_COST_PROGRESS: CostProgress = {
    seq: null,
    exactTurns: 0,
    estimatedTokens: 0,
    totalCostUsd: 0,
    freshInputCostUsd: 0,
    cacheWriteCostUsd: 0,
    cacheReadCostUsd: 0,
    outputCostUsd: 0,
};

export function costProgressThrough(
    turns: ReadonlyArray<Pick<InspectTurnDto, "seq" | "token_usage">>,
    seq: number | null,
): CostProgress {
    if (seq == null) return EMPTY_COST_PROGRESS;
    return turns.reduce<CostProgress>((acc, turn) => {
        if (turn.seq > seq || !turn.token_usage) return acc;
        const usage = turn.token_usage;
        return {
            seq,
            exactTurns: acc.exactTurns + 1,
            estimatedTokens: acc.estimatedTokens + (numberOrNull(usage.estimated_tokens) ?? 0),
            totalCostUsd: acc.totalCostUsd + (numberOrNull(usage.estimated_cost_usd) ?? 0),
            freshInputCostUsd: acc.freshInputCostUsd + (numberOrNull(usage.estimated_input_cost_usd) ?? 0),
            cacheWriteCostUsd: acc.cacheWriteCostUsd + (numberOrNull(usage.estimated_cache_creation_cost_usd) ?? 0),
            cacheReadCostUsd: acc.cacheReadCostUsd + (numberOrNull(usage.estimated_cache_read_cost_usd) ?? 0),
            outputCostUsd: acc.outputCostUsd + (numberOrNull(usage.estimated_output_cost_usd) ?? 0),
        };
    }, { ...EMPTY_COST_PROGRESS, seq });
}

function turnTokenUsageTitle(turn: InspectTurnDto): string {
    const usage = turn.token_usage;
    if (!usage) {
        return "No direct provider token usage event is attached to this transcript turn. Codex emits token accounting for model responses, not every user/tool/status row.";
    }
    return [
        `Exact provider usage for turn #${turn.seq}`,
        `cost ${fmtUsd(usage.estimated_cost_usd)}`,
        `tokens ${fmtCount(usage.estimated_tokens)}`,
        `fresh input ${fmtCount(usage.fresh_input_tokens)} / ${fmtUsd(usage.estimated_input_cost_usd)}`,
        `cache write ${fmtCount(usage.cache_creation_input_tokens)} / ${fmtUsd(usage.estimated_cache_creation_cost_usd)}`,
        `cache read ${fmtCount(usage.cache_read_input_tokens)} / ${fmtUsd(usage.estimated_cache_read_cost_usd)}`,
        `output ${fmtCount(usage.completion_tokens)} / ${fmtUsd(usage.estimated_output_cost_usd)}`,
        `${usage.usage_quality} · ${usage.usage_source}`,
    ].join("\n");
}

function blockFamily(kind: string): ContentTone {
    if (kind.includes("system") || kind.includes("instruction")) return { bg: "#e5e7eb", fg: "#1f2937", bar: "var(--muted)", label: "system" };
    if (kind.includes("environment") || kind.includes("context")) return { bg: "#dbeafe", fg: "#1e3a8a", bar: "var(--blue)", label: "context" };
    if (kind.includes("objective") || kind.includes("goal")) return { bg: "#dcfce7", fg: "#166534", bar: "#22c55e", label: "objective" };
    if (kind.includes("budget") || kind.includes("metric")) return { bg: "#ffedd5", fg: "#9a3412", bar: "#f97316", label: "budget" };
    if (kind.includes("assistant")) return { bg: "#cffafe", fg: "#155e75", bar: "#06b6d4", label: "assistant" };
    if (kind.includes("tool")) return { bg: "#ede9fe", fg: "#4c1d95", bar: "#8b5cf6", label: "tool" };
    if (kind.includes("hook")) return { bg: "color-mix(in srgb, var(--green) 14%, var(--panel))", fg: "color-mix(in srgb, var(--green) 45%, var(--ink))", bar: "var(--green)", label: "hook" };
    if (kind.includes("code")) return { bg: "var(--track)", fg: "var(--ink)", bar: "var(--muted)", label: "code" };
    if (kind.includes("heading")) return { bg: "#fee2e2", fg: "#991b1b", bar: "#ef4444", label: "heading" };
    if (kind.includes("paragraph")) return { bg: "#fef9c3", fg: "#78350f", bar: "#eab308", label: "paragraph" };
    return { bg: "var(--page)", fg: "var(--ink)", bar: "var(--muted-2)", label: blockLabel(kind) };
}

function blockLabel(kind: string): string {
    return kind.replace(/_/g, " ");
}

function atomRawObject(atom: InspectContentAtomDto): Record<string, unknown> {
    if (atom.raw && typeof atom.raw === "object" && !Array.isArray(atom.raw)) return atom.raw as Record<string, unknown>;
    if (typeof atom.raw === "string") {
        try {
            const parsed = JSON.parse(atom.raw);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch {
            return {};
        }
    }
    return {};
}

function sectionAliasAtoms(block: InspectContentBlockDto): InspectContentAtomDto[] {
    return block.atoms.filter((atom) => atom.kind === "section_alias");
}

function primarySectionAlias(block: InspectContentBlockDto): InspectContentAtomDto | null {
    const aliases = sectionAliasAtoms(block);
    return aliases.find((atom) => atomRawObject(atom)["primary"] === true) ?? aliases[0] ?? null;
}

function aliasLabel(atom: InspectContentAtomDto): string {
    const raw = atomRawObject(atom);
    return typeof raw["display"] === "string" ? raw["display"] : (ALIAS_STYLE[atom.value]?.label ?? blockLabel(atom.value));
}

function aliasTitle(atom: InspectContentAtomDto): string {
    const raw = atomRawObject(atom);
    const method = typeof raw["method"] === "string" ? raw["method"] : "section_alias";
    const matched = typeof raw["matched"] === "string" ? raw["matched"] : atom.value;
    const inherited = raw["inherited"] === true ? " inherited" : "";
    return `${aliasLabel(atom)} · ${method}${inherited} · ${Math.round(atom.confidence * 100)}% · ${matched}`;
}

function blockTone(block: InspectContentBlockDto): ContentTone {
    const alias = primarySectionAlias(block);
    if (alias) {
        const style = ALIAS_STYLE[alias.value] ?? ALIAS_STYLE.reference;
        return { ...style, label: aliasLabel(alias) };
    }
    return blockFamily(block.kind);
}

function displayBlockLabel(block: InspectContentBlockDto): string {
    const alias = primarySectionAlias(block);
    return alias ? aliasLabel(alias) : blockLabel(block.kind);
}

function blockHoverTitle(block: InspectContentBlockDto, mismatch: boolean): string {
    const alias = primarySectionAlias(block);
    const base = alias ? aliasTitle(alias) : blockLabel(block.kind);
    return mismatch ? `offset mismatch: ${base}` : base;
}

type InspectTarget =
    | { kind: "block"; blockSeq: number }
    | { kind: "atom"; blockSeq: number; atomIndex: number };

/**
 * The turn + block/atom currently surfaced in the docked right-rail inspector.
 * Lifted out of individual turns so ONE persistent inspector under the cost rail
 * tracks whatever the user last hovered, instead of a toggle per turn.
 */
export interface InspectSelection {
    turnSeq: number;
    content: InspectTurnContentDto;
    target: InspectTarget | null;
    turnUsage: TurnTokenUsageDetail | null;
    turnChars: number;
}

function sameInspectTarget(a: InspectTarget | null, b: InspectTarget | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.kind !== b.kind || a.blockSeq !== b.blockSeq) return false;
    return a.kind === "block" || a.atomIndex === (b as { kind: "atom"; atomIndex: number }).atomIndex;
}

function targetBlockSeq(target: InspectTarget | null): number | null {
    return target?.blockSeq ?? null;
}

function selectedBlock(content: InspectTurnContentDto, target: InspectTarget | null): InspectContentBlockDto | null {
    const seq = targetBlockSeq(target);
    return seq == null ? null : content.blocks.find((block) => block.seq === seq) ?? null;
}

function selectedAtom(block: InspectContentBlockDto | null, target: InspectTarget | null): InspectContentAtomDto | null {
    if (!block || target?.kind !== "atom") return null;
    return block.atoms[target.atomIndex] ?? null;
}

function contentBrief(text: string | null | undefined, max = 520): string {
    if (!text) return "";
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function atomDisplayLabel(atom: InspectContentAtomDto): string {
    return atom.kind === "section_alias" ? aliasLabel(atom) : blockLabel(atom.kind);
}

function atomTone(atom: InspectContentAtomDto): ContentTone {
    if (atom.kind === "section_alias") return ALIAS_STYLE[atom.value] ?? ALIAS_STYLE.reference;
    if (atom.kind.includes("file")) return { bg: "color-mix(in srgb, var(--blue) 8%, var(--panel))", fg: "color-mix(in srgb, var(--blue) 55%, var(--ink))", bar: "var(--blue)", label: "file" };
    if (atom.kind.includes("url") || atom.kind.includes("citation")) return { bg: "color-mix(in srgb, var(--blue) 6%, var(--panel))", fg: "color-mix(in srgb, var(--blue) 45%, var(--ink))", bar: "var(--blue)", label: "link" };
    if (atom.kind.includes("symbol")) return { bg: "color-mix(in srgb, var(--green) 8%, var(--panel))", fg: "color-mix(in srgb, var(--green) 45%, var(--ink))", bar: "var(--green)", label: "symbol" };
    if (atom.kind.includes("command")) return { bg: "color-mix(in srgb, var(--gold) 18%, var(--panel))", fg: "color-mix(in srgb, var(--gold) 45%, var(--ink))", bar: "var(--gold)", label: "command" };
    return { bg: "var(--page)", fg: "var(--ink)", bar: "var(--muted-2)", label: blockLabel(atom.kind) };
}

function AliasMiniMap({
    content,
    activeTarget,
    setActiveTarget,
}: {
    content: InspectTurnContentDto;
    activeTarget: InspectTarget | null;
    setActiveTarget: (target: InspectTarget | null) => void;
}) {
    const aliasBlocks = visibleTextBlocks(content)
        .map((block) => ({ block, alias: primarySectionAlias(block) }))
        .filter((entry): entry is { block: InspectContentBlockDto; alias: InspectContentAtomDto } => entry.alias !== null);
    const hasStructuralAlias = aliasBlocks.some((entry) => entry.alias.value !== "reference");
    // A reference-only turn would render an all-grey strip that first-time
    // readers parse as a skeleton loader or redaction - show nothing instead.
    if (!hasStructuralAlias) return null;
    const blocks = aliasBlocks.filter((entry) => entry.alias.value !== "reference");
    if (blocks.length === 0) return null;

    return (
        <div
            aria-label="turn semantic map"
            style={{
                display: "flex",
                gap: 2,
                height: 12,
                padding: "2px 0 5px",
                minWidth: 0,
            }}
        >
            {blocks.map(({ block, alias }) => {
                const tone = ALIAS_STYLE[alias.value] ?? ALIAS_STYLE.reference;
                const start = block.start_offset ?? 0;
                const end = block.end_offset ?? start;
                const width = Math.max(10, end - start);
                const active = targetBlockSeq(activeTarget) === block.seq;
                const target: InspectTarget = { kind: "block", blockSeq: block.seq };
                return (
                    <button
                        key={`map-${block.seq}-${alias.value}`}
                        type="button"
                        onMouseEnter={() => setActiveTarget(target)}
                        onClick={() => setActiveTarget(target)}
                        title={aliasTitle(alias)}
                        aria-label={aliasTitle(alias)}
                        style={{
                            flex: `${width} 1 10px`,
                            minWidth: 8,
                            height: 8,
                            padding: 0,
                            border: active ? `1px solid ${tone.fg}` : "1px solid transparent",
                            borderRadius: 2,
                            background: tone.bar,
                            opacity: active ? 1 : 0.72,
                            cursor: "pointer",
                        }}
                    />
                );
            })}
        </div>
    );
}

function visibleTextBlocks(content: InspectTurnContentDto): InspectContentBlockDto[] {
    const withOffsets = content.blocks
        .filter((block) => block.start_offset != null && block.end_offset != null)
        .filter((block) => (block.end_offset ?? 0) > (block.start_offset ?? 0));
    const parentsWithChildren = new Set(
        withOffsets
            .map((block) => block.parent_seq)
            .filter((seq): seq is number => seq != null),
    );
    const candidates = withOffsets.filter((block) =>
        block.parent_seq != null || !parentsWithChildren.has(block.seq)
    );
    const selected: InspectContentBlockDto[] = [];
    let cursor = -1;
    for (const block of candidates
        .slice()
        .sort((a, b) => (a.start_offset ?? 0) - (b.start_offset ?? 0))
    ) {
        const start = block.start_offset ?? 0;
        const end = block.end_offset ?? start;
        if (start < cursor) continue;
        selected.push(block);
        cursor = end;
    }
    return selected;
}

export function rawBlockTextStyle({
    tone,
    active,
    hovered,
    mismatch,
}: {
    tone: ContentTone;
    active: boolean;
    hovered: boolean;
    mismatch: boolean;
}): CSSProperties {
    const emphasized = active || hovered || mismatch;
    return {
        background: hovered ? tone.bg : "transparent",
        color: emphasized ? tone.fg : "inherit",
        outline: "none",
        outlineOffset: 1,
        borderBottom: mismatch
            ? "1px dotted #f97316"
            : emphasized ? `1px solid ${tone.bar}` : "1px solid transparent",
        boxShadow: active ? `inset 0 -2px 0 ${tone.bar}` : "none",
        cursor: "pointer",
        transition: "background 0.12s, color 0.12s, border-color 0.12s, box-shadow 0.12s",
    };
}

export function InspectGuide({ data }: { data: Pick<SessionInspectPayload, "total_chars" | "total_turns" | "token_usage"> }) {
    const usage = data.token_usage;
    const totalCost = tokenCostTotal(usage);
    const breakdownTotal = usage ? totalBreakdownCost(usage) : 0;
    const segments = usage ? costBarSegments(usage) : [];
    const gradient = segments
        .filter((segment) => (segment.value ?? 0) > 0 && breakdownTotal > 0)
        .reduce<{ stops: string[]; cursor: number }>((acc, segment) => {
            const width = ((segment.value ?? 0) / breakdownTotal) * 100;
            const next = acc.cursor + width;
            acc.stops.push(`${segment.color} ${acc.cursor.toFixed(2)}% ${next.toFixed(2)}%`);
            acc.cursor = next;
            return acc;
        }, { stops: [], cursor: 0 }).stops.join(", ");

    if (!usage) return null;

    return (
        <div style={{
            margin: "4px 24px 10px",
            padding: "8px 10px",
            border: "1px solid var(--line)",
            background: "var(--page)",
            display: "grid",
            gap: 7,
        }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                    <strong
                        title="Estimated total provider cost for this session from stored token usage and the model pricing catalog."
                        style={{ color: "#141615", font: "700 15px/1 ui-monospace, monospace" }}
                    >
                        {fmtUsd(totalCost)}
                    </strong>
                    <span
                        title="Total provider tokens reported for the session. This is billing telemetry, unlike the structure percentages below which are character share."
                        style={{ color: "var(--muted)", font: "11px/1.4 ui-monospace, monospace" }}
                    >
                        {fmtCount(usage.estimated_tokens)} tokens · {usage.model ?? "unknown model"}
                    </span>
                </div>
                <span style={{ color: "var(--muted)", font: "10px/1.4 ui-monospace, monospace" }}>
                    structure % = character share · hover metrics for definitions
                </span>
            </div>
            <div
                title={`Cost mix by provider billing component. Pricing: ${usage.pricing_source ?? "unknown"}. Per-turn headers below use turn usage when available; inspector block/span cost is character-allocated within the selected turn.`}
                style={{
                    height: 8,
                    border: "1px solid var(--line)",
                    background: gradient ? `linear-gradient(90deg, ${gradient})` : "var(--track)",
                }}
            />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {segments.map((segment) => (
                    <span
                        key={segment.label}
                        title={`${segment.label}: ${fmtUsd(segment.value)} (${pctOf(segment.value, breakdownTotal || totalCost)} of known cost components)`}
                        style={{
                            background: "var(--panel)",
                            color: "var(--ink)",
                            border: "1px solid var(--line)",
                            borderLeft: `3px solid ${segment.color}`,
                            padding: "2px 7px",
                            font: "10px/1.2 ui-monospace, monospace",
                        }}
                    >
                        {segment.label} {fmtUsd(segment.value)}
                    </span>
                ))}
            </div>
        </div>
    );
}

export function useVisibleTurnSeq(
    turns: ReadonlyArray<Pick<InspectTurnDto, "seq">>,
    fallbackSeq: number | null,
): number | null {
    const [visibleSeq, setVisibleSeq] = useState<number | null>(fallbackSeq);
    const turnSeqKey = turns.map((turn) => turn.seq).join(",");

    useEffect(() => {
        if (typeof window === "undefined") return;
        if (turns.length === 0) {
            setVisibleSeq(null);
            return;
        }

        let raf = 0;
        const update = () => {
            raf = 0;
            const anchorY = JUMP_TARGET_SCROLL_MARGIN + 24;
            let candidate: number | null = null;
            for (const turn of turns) {
                const el = document.getElementById(`turn-${turn.seq}`);
                if (!el) continue;
                const rect = el.getBoundingClientRect();
                if (rect.bottom < anchorY) {
                    candidate = turn.seq;
                    continue;
                }
                if (rect.top <= anchorY) {
                    candidate = turn.seq;
                    break;
                }
                if (candidate == null) candidate = turn.seq;
                break;
            }
            setVisibleSeq(candidate ?? fallbackSeq ?? turns[0]?.seq ?? null);
        };
        const schedule = () => {
            if (raf) return;
            raf = window.requestAnimationFrame(update);
        };

        update();
        window.addEventListener("scroll", schedule, { passive: true });
        window.addEventListener("resize", schedule);
        return () => {
            if (raf) window.cancelAnimationFrame(raf);
            window.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
        };
    }, [fallbackSeq, turnSeqKey]);

    return visibleSeq;
}

export function CostRail({
    data,
    currentSeq,
    docked = false,
}: {
    data: Pick<SessionInspectPayload, "turns" | "total_turns" | "token_usage">;
    currentSeq: number | null;
    /** When rendered inside the shared sticky right column, the column owns the
     *  sticky/scroll/margin so the rail itself drops its own positioning. */
    docked?: boolean;
}) {
    const usage = data.token_usage;
    const sessionCost = tokenCostTotal(usage);
    const progress = costProgressThrough(data.turns, currentSeq);
    const exactTurnCount = data.turns.filter((turn) => turn.token_usage).length;
    const progressPct = sessionCost && sessionCost > 0
        ? `${((progress.totalCostUsd / sessionCost) * 100).toFixed(1)}%`
        : "-";
    const rows = [
        ["fresh", progress.freshInputCostUsd, "var(--blue)", "Fresh input billed at normal input price."],
        ["cache write", progress.cacheWriteCostUsd, "#f59e0b", "Cache creation cost reported by provider usage."],
        ["cache read", progress.cacheReadCostUsd, "#10b981", "Cached input read cost reported by provider usage."],
        ["output", progress.outputCostUsd, "#8b5cf6", "Output token cost reported by provider usage."],
    ] as const;

    if (!usage) return null;

    return (
        <aside style={{
            ...(docked
                ? { flex: "0 0 auto" }
                : {
                    position: "sticky",
                    top: 48,
                    alignSelf: "flex-start",
                    flex: "0 0 228px",
                    margin: "0 24px 16px 0",
                    maxHeight: "calc(100vh - 64px)",
                    overflow: "auto",
                }),
            border: "1px solid var(--line)",
            background: "var(--page)",
            fontFamily: "ui-monospace, monospace",
            color: "var(--ink)",
        }}>
            <div style={{ padding: "8px 9px", borderBottom: "1px solid var(--line)" }}>
                <div style={{ color: "var(--muted)", font: "700 10px/1.2 ui-monospace, monospace", textTransform: "uppercase" }}>
                    cost so far
                </div>
                <div
                    title="Exact provider token usage summed through the currently visible turn. Missing transcript rows are not estimated in this rail."
                    style={{ marginTop: 6, color: "var(--ink)", font: "700 20px/1 ui-monospace, monospace" }}
                >
                    {fmtUsd(progress.totalCostUsd)}
                </div>
                <div style={{ marginTop: 5, color: "var(--muted)", font: "10px/1.35 ui-monospace, monospace" }}>
                    through #{currentSeq ?? "-"} · {progressPct} of session
                </div>
            </div>
            <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "5px 8px", margin: 0, padding: "8px 9px", font: "10px/1.25 ui-monospace, monospace" }}>
                <dt style={{ color: "var(--muted)" }}>exact turns</dt>
                <dd style={{ margin: 0, fontWeight: 700 }}>{progress.exactTurns}/{exactTurnCount}</dd>
                <dt style={{ color: "var(--muted)" }}>tokens</dt>
                <dd style={{ margin: 0, fontWeight: 700 }}>{fmtCount(progress.estimatedTokens)}</dd>
                <dt style={{ color: "var(--muted)" }}>session total</dt>
                <dd style={{ margin: 0, fontWeight: 700 }}>{fmtUsd(sessionCost)}</dd>
            </dl>
            <div style={{ display: "grid", gap: 5, padding: "0 9px 9px" }}>
                {rows.map(([label, value, color, title]) => (
                    <div
                        key={label}
                        title={title}
                        style={{ display: "flex", justifyContent: "space-between", gap: 8, border: "1px solid var(--line)", background: "#fff", borderLeft: `3px solid ${color}`, padding: "5px 6px", font: "10px/1.2 ui-monospace, monospace" }}
                    >
                        <span style={{ color: "var(--muted)" }}>{label}</span>
                        <strong>{fmtUsd(value)}</strong>
                    </div>
                ))}
            </div>
            <div style={{ borderTop: "1px solid var(--line)", padding: "7px 9px", color: "var(--muted)", font: "10px/1.35 ui-monospace, monospace" }}>
                Exact provider rows only. Turns without token events are explained on hover.
            </div>
        </aside>
    );
}

type InspectRailData = Pick<SessionInspectPayload, "turns" | "total_turns" | "token_usage">;

/**
 * Owns the docked inspector's selection (which turn + block/atom). Seeds to the
 * first turn with parsed content so the right-rail panel is populated on load,
 * then follows whatever block/alias the user hovers. Shared by the dashboard and
 * the public share view so both behave identically.
 */
export function useInspectSelection(data: InspectRailData | null) {
    const [selection, setSelection] = useState<InspectSelection | null>(null);
    useEffect(() => {
        if (selection || !data) return;
        const first = data.turns.find((turn) => turn.content);
        if (first?.content) {
            setSelection({
                turnSeq: first.seq,
                content: first.content,
                target: null,
                turnUsage: first.token_usage ?? null,
                turnChars: first.char_count,
            });
        }
    }, [data, selection]);
    return [selection, setSelection] as const;
}

/**
 * The persistent right column: the cost rail with the parsed-block inspector
 * docked beneath it. Sticky so it stays in view while the turn list scrolls.
 */
export function DockedRail({
    data,
    currentSeq,
    selection,
    setSelection,
}: {
    data: InspectRailData;
    currentSeq: number | null;
    selection: InspectSelection | null;
    setSelection: (selection: InspectSelection | null) => void;
}) {
    return (
        <div className="docked-rail" style={{
            flex: "0 0 320px",
            alignSelf: "flex-start",
            position: "sticky",
            top: 48,
            maxHeight: "calc(100vh - 64px)",
            overflow: "auto",
            margin: "0 24px 16px 0",
            display: "flex",
            flexDirection: "column",
            gap: 8,
        }}>
            <CostRail data={data} currentSeq={currentSeq} docked />
            {selection ? (
                <TurnContentInspector
                    content={selection.content}
                    activeTarget={selection.target}
                    setActiveTarget={(target) =>
                        setSelection(selection ? { ...selection, target } : selection)}
                    turnUsage={selection.turnUsage}
                    turnChars={selection.turnChars}
                    turnSeq={selection.turnSeq}
                    maxHeight="calc(100vh - 320px)"
                />
            ) : (
                <aside style={{
                    border: "1px solid var(--line)", background: "var(--page)",
                    padding: 10, color: "var(--muted-2)",
                    font: "11px/1.5 ui-monospace, monospace",
                }}>
                    Hover a turn’s text to inspect its parsed blocks here.
                </aside>
            )}
        </div>
    );
}

const SYMBOL_REF_STYLE = { fontWeight: 700, color: "#15803d" } as const;

/**
 * Render a block's raw slice with symbol-reference atom values bolded inline,
 * so named entities (e.g. `SurrealDB`) stand out in the transcript itself
 * rather than only in the inspector's atom list. Atoms carry no offsets, so we
 * match by value (longest-first; word boundaries so "data" doesn't bold inside
 * "metadata").
 */
function renderSliceWithSymbols(slice: string, block: InspectContentBlockDto): ReactNode {
    const symbols = [...new Set(
        block.atoms
            .filter((a) => a.kind.includes("symbol") && a.value.length > 0)
            .map((a) => a.value),
    )].sort((a, b) => b.length - a.length);
    if (symbols.length === 0) return slice;
    const escaped = symbols.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
    const symbolSet = new Set(symbols);
    return slice.split(re).map((part, i) =>
        symbolSet.has(part)
            ? <strong key={i} style={SYMBOL_REF_STYLE} title="symbol reference">{part}</strong>
            : part,
    );
}

function AnnotatedRawText({
    content,
    rawText,
    activeTarget,
    setActiveTarget,
    maxHeight,
}: {
    content: InspectTurnContentDto;
    rawText: string;
    activeTarget: InspectTarget | null;
    setActiveTarget: (target: InspectTarget | null) => void;
    maxHeight: number;
}) {
    const blocks = visibleTextBlocks(content);
    const activeSeq = targetBlockSeq(activeTarget);
    const [hoverSeq, setHoverSeq] = useState<number | null>(null);

    const rawParts: ReactNode[] = [];
    let cursor = 0;
    for (const block of blocks) {
        const start = block.start_offset ?? 0;
        const end = block.end_offset ?? start;
        if (start > cursor) rawParts.push(rawText.slice(cursor, start));
        const family = blockTone(block);
        const slice = rawText.slice(start, end);
        const mismatch = block.text != null && slice !== block.text;
        const active = activeSeq === block.seq;
        const hovered = hoverSeq === block.seq;
        const target: InspectTarget = { kind: "block", blockSeq: block.seq };
        rawParts.push(
            <span
                key={`raw-${block.seq}`}
                onMouseEnter={() => { setHoverSeq(block.seq); setActiveTarget(target); }}
                onMouseLeave={() => setHoverSeq((seq) => seq === block.seq ? null : seq)}
                onClick={() => setActiveTarget(target)}
                title={blockHoverTitle(block, mismatch)}
                style={rawBlockTextStyle({ tone: family, active, hovered, mismatch })}
            >
                {renderSliceWithSymbols(slice, block)}
            </span>,
        );
        cursor = end;
    }
    if (cursor < rawText.length) rawParts.push(rawText.slice(cursor));

    return (
        <pre style={{
            margin: 0,
            padding: 10,
            maxHeight,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            font: "12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace",
            background: "#fff",
        }}>
            {rawParts.length > 0 ? rawParts : rawText}
        </pre>
    );
}

export function TurnContentInspector({
    content,
    activeTarget,
    setActiveTarget,
    turnUsage,
    turnChars,
    maxHeight = 400,
    turnSeq,
}: {
    content: InspectTurnContentDto;
    activeTarget: InspectTarget | null;
    setActiveTarget: (target: InspectTarget | null) => void;
    turnUsage?: TurnTokenUsageDetail | null;
    turnChars: number;
    maxHeight?: number | string;
    /** Shown in the header so the docked inspector says which turn it reflects. */
    turnSeq?: number;
}) {
    const block = selectedBlock(content, activeTarget) ?? visibleTextBlocks(content)[0] ?? content.blocks[0] ?? null;
    const atom = selectedAtom(block, activeTarget);
    const family = block ? blockTone(block) : ALIAS_STYLE.reference;
    const blockAtoms = block?.atoms ?? [];
    const blockChars = block
        ? Math.max(0, (block.end_offset ?? 0) - (block.start_offset ?? 0))
        : 0;
    const blockTotalCost = turnUsage
        ? estimateCharWeightedCost(turnUsage.estimated_cost_usd, turnChars, blockChars)
        : null;
    const blockCacheReadCost = turnUsage
        ? estimateCharWeightedCost(turnUsage.estimated_cache_read_cost_usd, turnChars, blockChars)
        : null;

    return (
        <aside style={{ border: "1px solid var(--line)", background: "var(--page)", minWidth: 0, maxHeight, overflow: "auto" }}>
            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <strong style={{ color: "var(--ink)", font: "700 10px/1 ui-monospace, monospace", textTransform: "uppercase" }}>
                    inspector{turnSeq != null ? ` · #${turnSeq}` : ""}
                </strong>
                <span style={{ color: "var(--muted-2)", font: "10px/1 ui-monospace, monospace" }}>
                    {content.parser_id}@{content.parser_version}
                </span>
            </div>
            {!block ? (
                <div style={{ padding: 10, color: "var(--muted-2)", font: "11px/1.5 ui-monospace, monospace" }}>No parsed block selected.</div>
            ) : (
                <div style={{ padding: 10, display: "grid", gap: 8 }}>
                    <div style={{ background: "#fff", border: "1px solid var(--line)", boxShadow: `inset 4px 0 0 ${family.bar}`, padding: "8px 9px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                            <strong style={{ color: family.fg, font: "700 11px/1 ui-monospace, monospace", textTransform: "uppercase" }}>
                                {displayBlockLabel(block)}
                            </strong>
                            <span style={{ color: "var(--muted-2)", font: "10px/1 ui-monospace, monospace" }}>
                                block #{block.seq}{block.parent_seq == null ? "" : ` / parent ${block.parent_seq}`}
                            </span>
                        </div>
                        <div style={{ marginTop: 6, color: "var(--muted)", font: "10px/1.3 ui-monospace, monospace" }}>
                            {block.kind} · {Math.round(block.confidence * 100)}% · {block.start_offset ?? "?"}-{block.end_offset ?? "?"}
                        </div>
                        {block.heading ? (
                            <div style={{ marginTop: 7, color: "var(--ink)", font: "700 11px/1.35 ui-monospace, monospace" }}>{block.heading}</div>
                        ) : null}
                        <pre style={{ margin: "7px 0 0", color: "var(--ink)", font: "11px/1.45 ui-monospace, monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                            {contentBrief(block.text_excerpt ?? block.text)}
                        </pre>
                    </div>

                    {turnUsage ? (
                        <div style={{ background: "#fff", border: "1px solid var(--line)", padding: "8px 9px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                                <strong style={{ color: "var(--ink)", font: "700 10px/1 ui-monospace, monospace", textTransform: "uppercase" }}>
                                    estimated cost lens
                                </strong>
                                <span style={{ color: "var(--muted-2)", font: "10px/1 ui-monospace, monospace" }}>
                                    char-weighted
                                </span>
                            </div>
                            <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 8px", margin: "7px 0 0", font: "11px/1.35 ui-monospace, monospace" }}>
                                <dt style={{ color: "var(--muted)" }}>allocated block cost</dt>
                                <dd style={{ margin: 0, fontWeight: 700 }}>{fmtUsd(blockTotalCost)}</dd>
                                <dt style={{ color: "var(--muted)" }}>cache-read share</dt>
                                <dd style={{ margin: 0, fontWeight: 700 }}>{fmtUsd(blockCacheReadCost)}</dd>
                                <dt style={{ color: "var(--muted)" }}>block chars</dt>
                                <dd style={{ margin: 0 }}>{fmtCount(blockChars)}</dd>
                                <dt style={{ color: "var(--muted)" }}>turn tokens</dt>
                                <dd style={{ margin: 0 }}>{fmtCount(turnUsage.estimated_tokens)}</dd>
                            </dl>
                            <div style={{ marginTop: 6, color: "var(--muted)", fontSize: 11, lineHeight: 1.35 }}>
                                Turn usage is provider-derived; block/span cost is allocated by character share inside this turn.
                            </div>
                        </div>
                    ) : null}

                    {atom ? (
                        <AtomCard atom={atom} active />
                    ) : null}

                    <div>
                        <div style={{ color: "var(--muted)", font: "700 10px/1 ui-monospace, monospace", textTransform: "uppercase", marginBottom: 5 }}>
                            atoms in this block · {blockAtoms.length}
                        </div>
                        {blockAtoms.length === 0 ? (
                            <div style={{ color: "var(--muted-2)", font: "11px/1.5 ui-monospace, monospace" }}>No references or semantic atoms extracted.</div>
                        ) : (
                            <div style={{ display: "grid", gap: 5 }}>
                                {blockAtoms.map((entry, index) => {
                                    const target: InspectTarget = { kind: "atom", blockSeq: block.seq, atomIndex: index };
                                    const active = sameInspectTarget(activeTarget, target);
                                    return (
                                        <button
                                            key={`${entry.kind}-${entry.value}-${index}`}
                                            type="button"
                                            onMouseEnter={() => setActiveTarget(target)}
                                            onClick={() => setActiveTarget(target)}
                                            style={{
                                                textAlign: "left",
                                                padding: 0,
                                                border: "none",
                                                background: "transparent",
                                                cursor: "pointer",
                                            }}
                                        >
                                            <AtomCard atom={entry} active={active} compact />
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                    {content.blockset_hash ? (
                        <div style={{ color: "var(--muted-2)", font: "10px/1.35 ui-monospace, monospace", borderTop: "1px solid var(--line)", paddingTop: 7 }}>
                            blockset {content.blockset_hash.slice(0, 12)}
                        </div>
                    ) : null}
                </div>
            )}
        </aside>
    );
}

function AtomCard({ atom, active, compact = false }: { atom: InspectContentAtomDto; active: boolean; compact?: boolean }) {
    const tone = atomTone(atom);
    const raw = atomRawObject(atom);
    const method = typeof raw["method"] === "string" ? raw["method"] : null;
    const matched = typeof raw["matched"] === "string" ? raw["matched"] : null;
    return (
        <div style={{
            border: `1px solid ${active ? tone.bar : "var(--line)"}`,
            boxShadow: `inset 3px 0 0 ${tone.bar}`,
            background: active ? tone.bg : "#fff",
            padding: compact ? "6px 7px" : "8px 9px",
        }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <strong style={{ color: tone.fg, font: "700 10px/1 ui-monospace, monospace", textTransform: "uppercase" }}>
                    {atomDisplayLabel(atom)}
                </strong>
                <span style={{ color: "var(--muted-2)", font: "10px/1 ui-monospace, monospace" }}>
                    {Math.round(atom.confidence * 100)}%
                </span>
            </div>
            <div style={{ marginTop: 4, color: "var(--ink)", font: "11px/1.35 ui-monospace, monospace", overflowWrap: "anywhere" }}>
                {atom.normalized ?? atom.value}
            </div>
            {!compact && (method || matched) ? (
                <div style={{ marginTop: 5, color: "var(--muted)", font: "10px/1.35 ui-monospace, monospace" }}>
                    {method ? `method: ${method}` : null}
                    {method && matched ? " · " : null}
                    {matched ? `matched: ${matched}` : null}
                </div>
            ) : null}
        </div>
    );
}

interface SpawnMetaDto {
    readonly provider: string;
    readonly agent_type: string | null;
    readonly fork_context: boolean | null;
    readonly reasoning_effort: string | null;
    readonly brief: string | null;
}

export interface SpawnChildDto {
    readonly session_id: string;
    readonly nickname: string | null;
    readonly tool: string | null;
    readonly ts: string | null;
    readonly meta: SpawnMetaDto | null;
    readonly turns: number | null;
    readonly tool_calls: number | null;
    readonly est_tokens: number | null;
    readonly cost_usd: number | null;
    readonly duration_ms: number | null;
}

/** Compact token count for a plain number: `30.3k` / `156` / null when empty.
 *  Mirrors compactTokenCount (which takes a TurnTokenUsageDetail). */
export function compactTokens(n: number | null | undefined): string | null {
    if (n == null || !Number.isFinite(n) || n <= 0) return null;
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** Glanceable duration from milliseconds: `42s` / `1m58s` / `1h2m` / null. */
export function fmtDurationMs(ms: number | null | undefined): string | null {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}

/** The dim subagent-metric chips shared by the live + (mirrored) share marker.
 *  Returns the ordered, null-omitted label set. */
export function subagentMetricChips(child: {
    readonly turns: number | null;
    readonly tool_calls: number | null;
    readonly est_tokens: number | null;
    readonly duration_ms: number | null;
    readonly cost_usd: number | null;
}): ReadonlyArray<string> {
    const out: string[] = [];
    if (child.turns != null) out.push(`${child.turns} turns`);
    if (child.tool_calls != null) out.push(`${child.tool_calls} tools`);
    const tok = compactTokens(child.est_tokens);
    if (tok) out.push(`${tok} tok`);
    const dur = fmtDurationMs(child.duration_ms);
    if (dur) out.push(dur);
    if (child.cost_usd != null && Number.isFinite(child.cost_usd)) {
        out.push(child.cost_usd >= 0.01 ? `$${child.cost_usd.toFixed(2)}` : `$${child.cost_usd.toFixed(4)}`);
    }
    return out;
}

function SpawnMarker({ child }: { child: SpawnChildDto }) {
    // Wire seam: child.session_id is already bare (see src/lib/shared/session-id.ts).
    const childBare = child.session_id;
    const ts = child.ts ? new Date(child.ts).toISOString().slice(11, 19) : "";
    const m = child.meta;
    const chips: Array<{ label: string; value: string }> = [];
    if (m?.agent_type) chips.push({ label: "type", value: m.agent_type });
    if (m?.reasoning_effort) chips.push({ label: "effort", value: m.reasoning_effort });
    if (m?.fork_context != null) chips.push({ label: "fork", value: m.fork_context ? "yes" : "no" });
    const metrics = subagentMetricChips(child);

    // Prefetch the spawned child's inspect data on hover/focus only -
    // mass-prefetching all 52 spawn markers at once would stampede the API.
    const queryClient = useQueryClient();
    const onIntent = () => {
        void queryClient.prefetchQuery({
            queryKey: ["session-inspect", childBare],
            queryFn: () => api.sessionInspect(childBare),
            staleTime: 5 * 60_000,
        });
    };

    const [expanded, setExpanded] = useState(false);
    const brief = m?.brief ?? null;
    const briefClippedLen = 200;
    const briefIsLong = !!brief && brief.length > briefClippedLen;

    return (
        <div onMouseEnter={onIntent} onFocus={onIntent} style={{
            margin: "4px 0", padding: "7px 10px", background: "color-mix(in srgb, var(--rose) 8%, var(--panel))",
            border: "1px solid color-mix(in srgb, var(--rose) 25%, var(--panel))", borderLeft: "4px solid var(--rose)", borderRadius: 3, fontSize: 11,
            fontFamily: "ui-monospace, monospace", color: "var(--rose)",
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>↳ child session spawned</span>
                <Link
                    to="/sessions/$sessionId/inspect"
                    params={{ sessionId: childBare }}
                    preload="intent"
                    style={{ color: "var(--rose)", fontWeight: 600 }}
                >
                    {child.nickname ? `"${child.nickname}"` : `${childBare.slice(0, 12)}…`}
                </Link>
                {child.nickname ? <span style={{ opacity: 0.6 }}>{childBare.slice(0, 10)}…</span> : null}
                {child.tool ? <span style={{ opacity: 0.6 }}>via {child.tool}</span> : null}
                {m ? <span style={{ background: "color-mix(in srgb, var(--rose) 25%, var(--panel))", color: "color-mix(in srgb, var(--rose) 45%, var(--ink))", padding: "0 6px", borderRadius: 2, fontSize: 10, fontWeight: 600 }}>{m.provider}</span> : null}
                {chips.map((c) => (
                    <span key={c.label} style={{ background: "#fee2e2", padding: "0 6px", borderRadius: 2, fontSize: 10 }}>
                        {c.label}: <strong>{c.value}</strong>
                    </span>
                ))}
                <span style={{ opacity: 0.6, marginLeft: "auto" }}>{ts}</span>
            </div>
            {metrics.length > 0 ? (
                <div style={{ marginTop: 4, opacity: 0.7, fontSize: 10, letterSpacing: 0.2 }}>
                    {metrics.join(" · ")}
                </div>
            ) : null}
            {brief ? (
                <div style={{ marginTop: 4, color: "color-mix(in srgb, var(--rose) 45%, var(--ink))", opacity: 0.9, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    <span style={{ fontStyle: "italic" }}>
                        “{expanded || !briefIsLong ? brief : `${brief.slice(0, briefClippedLen - 1)}…`}”
                    </span>
                    {briefIsLong ? (
                        <button
                            onClick={() => setExpanded((v) => !v)}
                            style={{
                                marginLeft: 6, padding: "0 6px", fontSize: 10, fontFamily: "inherit",
                                background: "transparent", border: "1px solid color-mix(in srgb, var(--rose) 25%, var(--panel))", borderRadius: 3,
                                color: "var(--rose)", cursor: "pointer",
                            }}
                        >
                            {expanded ? "show less" : `show full (${brief.length.toLocaleString()}c)`}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

/** A PreToolUse hook decision spliced into the turn stream. Green vertical
 *  bar matches the existing "hook_injection" span color in KIND_STYLE so the
 *  visual language is consistent. Chips surface inject/reason/event; when
 *  inject=true we also show the clipped titles of the prior-session memory
 *  that landed in the agent's context window. */
export function HookFireMarker({ hook }: { hook: HookFireDto }) {
    const ts = hook.ts ? new Date(hook.ts).toISOString().slice(11, 19) : "";
    const injectBg = hook.inject ? "color-mix(in srgb, var(--green) 14%, var(--panel))" : "var(--line)";
    const injectFg = hook.inject ? "color-mix(in srgb, var(--green) 45%, var(--ink))" : "var(--muted)";
    const filePathShort = hook.file_path.length > 60
        ? `…${hook.file_path.slice(-58)}`
        : hook.file_path;
    return (
        <div
            id={`hook-${hook.idx}`}
            data-hook-fire="true"
            style={{
                margin: "4px 24px", padding: "6px 10px",
                scrollMarginTop: JUMP_TARGET_SCROLL_MARGIN,
                borderLeft: "3px solid #10b981",
                background: hook.inject ? "color-mix(in srgb, var(--green) 8%, var(--panel))" : "var(--page)",
                borderRadius: 3, fontSize: 11,
                fontFamily: "ui-monospace, monospace", color: "color-mix(in srgb, var(--green) 45%, var(--ink))",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600 }}>⚙ hook_fire</span>
                <span style={{ background: injectBg, color: injectFg, padding: "0 6px", borderRadius: 2, fontSize: 10, fontWeight: 600 }}>
                    inject: {hook.inject ? "yes" : "no"}
                </span>
                <span style={{ background: "color-mix(in srgb, var(--blue) 14%, var(--panel))", color: "color-mix(in srgb, var(--blue) 45%, var(--ink))", padding: "0 6px", borderRadius: 2, fontSize: 10 }}>
                    event: <strong>{hook.event}</strong>
                </span>
                <span style={{ background: "color-mix(in srgb, var(--gold) 18%, var(--panel))", color: "color-mix(in srgb, var(--gold) 45%, var(--ink))", padding: "0 6px", borderRadius: 2, fontSize: 10 }}>
                    reason: <strong>{hook.reason}</strong>
                </span>
                <span style={{ color: "var(--muted)", fontSize: 10 }}>{hook.latency_ms}ms</span>
                <span style={{ color: "var(--muted)", marginLeft: "auto" }}>{ts}</span>
            </div>
            <div style={{ marginTop: 3, color: "var(--muted)", fontSize: 11, wordBreak: "break-all" }}>
                {filePathShort}
            </div>
            {hook.inject && hook.injected_titles.length > 0 ? (
                <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px dashed color-mix(in srgb, var(--green) 30%, var(--panel))", fontSize: 10, color: "color-mix(in srgb, var(--green) 45%, var(--ink))" }}>
                    <span style={{ fontWeight: 600 }}>injected memory ({hook.injected_titles.length}):</span>
                    <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
                        {hook.injected_titles.map((t, i) => (
                            <li key={i} style={{ listStyle: "disc", lineHeight: 1.4 }}>{t}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}

// --- Turn layout grid -------------------------------------------------------
// Every turn type shares ONE alignment grid so the `#seq` gutter, the header
// metadata, and ALL body content (user text, assistant prose, tool cards)
// line up on a single content-left edge.
//
//   | accent | GUTTER | CONTENT COLUMN ............. |
//     3px      44px     1fr  (header + body align here)
//
// Horizontal padding lives on the outer container; the grid sits inside it.
const TURN_PAD_X = 16;
const TURN_GUTTER = 36; // fixed seq column width (was: 48 min in full / auto in tool)
const TURN_COL_GAP = 8;
const turnMono = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** The single restrained header every turn shares:
 *  `#seq · ●role · time · $cost · Ntok` - all dim, one line.
 *  Role is a small color dot + lowercase word (the loud uppercase tinted pill
 *  is gone; the kind COLOR survives as the dot + the left accent bar).
 *  Token internals (fresh/cache/output) + char/span structure are demoted to
 *  the hover title only. */
function TurnHeader({
    turn,
    style,
    extras,
    rightSlot,
    hideRoleLabel,
}: {
    turn: InspectTurnDto;
    style: KindStyle;
    /** Inline nodes inserted after the role marker (e.g. spawned-child, jsonl badge). */
    extras?: ReactNode;
    /** Right-aligned slot (e.g. "inspecting →"). */
    rightSlot?: ReactNode;
    /** Tool-only turns: the card below states the tool identity, so the header
     *  keeps the color dot for the grid but drops the redundant role word. */
    hideRoleLabel?: boolean;
}) {
    const ts = turn.ts ? new Date(turn.ts).toISOString().slice(11, 19) : "";
    const usage = turn.token_usage ?? null;
    const cost = numberOrNull(usage?.estimated_cost_usd);
    const tok = usage ? compactTokenCount(usage) : null;
    const dim = "var(--muted)";
    const structureTitle =
        `${turn.char_count.toLocaleString()} characters · ${turn.spans.length} classified span${turn.spans.length === 1 ? "" : "s"} from the raw transcript.`;
    return (
        <div
            style={{
                gridColumn: "2",
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                fontSize: 10.5,
                lineHeight: 1.6,
                color: dim,
                fontFamily: turnMono,
                flexWrap: "wrap",
            }}
        >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
                <span
                    aria-hidden
                    title={hideRoleLabel ? undefined : `${style.label} turn`}
                    style={{ width: 6, height: 6, borderRadius: 2, background: style.bar, flex: "0 0 auto", transform: "translateY(1px)" }}
                />
                {hideRoleLabel
                    ? <span className="sr-only">{style.label} turn</span>
                    : <span style={{ color: style.fg, opacity: 0.85, fontWeight: 600 }}>{style.label}</span>}
            </span>
            {ts ? <span title="Turn timestamp from the source transcript." style={{ color: dim }}>{ts}</span> : null}
            {cost !== null ? <span title={turnTokenUsageTitle(turn)} style={{ color: dim }}>{fmtUsd(cost)}</span> : null}
            {/* Cumulative context size, not per-turn spend - label it that way.
                Char-count was pipeline telemetry with no reader value (hover
                still carries the structural breakdown via turnTokenUsageTitle). */}
            {tok ? <span title={turnTokenUsageTitle(turn)} style={{ color: dim }}>{tok} ctx</span> : null}
            {extras}
            {rightSlot ? <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "baseline", gap: 6 }}>{rightSlot}</span> : null}
        </div>
    );
}

function TurnImpl({
    turn,
    anchored,
    childrenSpawnedHere,
    activeTarget,
    onInspect,
    resultFor,
    skillContentFor,
    imagePaths: imagePathsProp,
}: {
    turn: InspectTurnDto;
    anchored: boolean;
    childrenSpawnedHere?: ReadonlyArray<SpawnChildDto>;
    /** Non-null only when THIS turn owns the docked inspector's current target. */
    activeTarget: InspectTarget | null;
    /** Hover/click a block or alias to surface it in the docked rail inspector. */
    onInspect: (selection: InspectSelection) => void;
    /** Paired tool_result output for this turn's i-th tool call, when the
     *  following tool_result turn was merged into the card (live path). */
    resultFor?: (callIndex: number) => string | undefined;
    /** Injected SKILL.md for this turn's i-th call when it is a `Skill` call
     *  whose following skill_context turn was folded into the card. */
    skillContentFor?: (callIndex: number) => string | undefined;
    /** Merged image paths to render on this turn: its own `[Image: source: …]`
     *  refs plus any folded in from following pure-attachment turns
     *  ({@link pairImageAttachments}). When absent, falls back to extracting
     *  the turn's own paths so turns rendered outside the paired path don't
     *  regress. */
    imagePaths?: ReadonlyArray<string>;
}) {
    const turnUsage = turn.token_usage ?? null;
    // Routes every block/alias hover+click up to the shared docked inspector,
    // tagged with this turn's content + usage so the rail can show cost lenses.
    const setActiveTarget = (target: InspectTarget | null) => {
        if (!turn.content) return;
        onInspect({ turnSeq: turn.seq, content: turn.content, target, turnUsage, turnChars: turn.char_count });
    };
    const s = KIND_STYLE[turn.semantic_role];
    const spawnedChildCount = childrenSpawnedHere?.length ?? 0;
    const spawnBadge = spawnedChildCount > 0
        ? (
            <span title={`This turn spawned ${spawnedChildCount} sub-agent session${spawnedChildCount === 1 ? "" : "s"}.`}
                style={{ color: "var(--rose)", fontWeight: 700 }}>
                spawn x{spawnedChildCount}
            </span>
        )
        : null;
    const inspectingBadge = turn.content && activeTarget
        ? (
            <span title="This turn is showing in the docked inspector on the right." style={{ color: "var(--ink)", fontWeight: 600 }}>
                inspecting →
            </span>
        )
        : null;
    const headerExtras = spawnBadge ? <>{spawnBadge}</> : undefined;

    // The `#seq` anchor lives in the fixed gutter (column 1) for EVERY turn
    // type so the content column (header + body) starts at one shared left
    // edge. The accent bar carries the kind color at x=0.
    const seqGutter = (
        <a
            href={`#turn-${turn.seq}`}
            style={{
                gridColumn: "1",
                gridRow: "1",
                color: "var(--muted)",
                textDecoration: "none",
                fontSize: 10.5,
                lineHeight: 1.6,
                fontFamily: turnMono,
                textAlign: "right",
                paddingRight: 2,
            }}
        >
            #{turn.seq}
        </a>
    );

    // A tool-ONLY turn carries no assistant prose - just the tool call(s). The
    // card below already states the tool identity, tokens and result, so the
    // header collapses to the shared dim row; the body is the card alone. It
    // uses the SAME grid as every other turn, so the card's content edge lines
    // up with user/assistant body text.
    const toolOnly = !!turn.tool_calls && turn.tool_calls.length > 0 && !turn.content && turn.char_count === 0
        && spawnedChildCount === 0 && turn.semantic_role !== "tool_result";

    // On-disk images pasted as `[Image: source: /…/foo.png]` text refs. The
    // daemon serves the bytes; a missing file degrades to the text ref. The
    // transcript supplies a merged list (own refs + folded pure-attachment
    // turns); fall back to this turn's own refs when rendered standalone.
    const imagePaths = imagePathsProp ?? extractImagePaths(turn.raw_text ?? "");

    const gridStyle: CSSProperties = {
        display: "grid",
        gridTemplateColumns: `${TURN_GUTTER}px 1fr`,
        columnGap: TURN_COL_GAP,
        rowGap: 4,
        padding: `8px ${TURN_PAD_X}px`,
        scrollMarginTop: JUMP_TARGET_SCROLL_MARGIN,
        borderLeft: `3px solid ${s.bar}`,
        background: anchored ? "color-mix(in srgb, var(--blue) 8%, transparent)" : "transparent",
        transition: "background 0.6s",
    };

    if (toolOnly) {
        return (
            <div id={`turn-${turn.seq}`} className="turn-row" title={turnTokenUsageTitle(turn)} style={gridStyle}>
                {seqGutter}
                <TurnHeader turn={turn} style={s} extras={headerExtras} hideRoleLabel />
                <div style={{ gridColumn: "2", minWidth: 0, maxWidth: "92ch" }}>
                    <ToolRow calls={turn.tool_calls!} resultFor={resultFor} skillContentFor={skillContentFor} />
                    <TurnImages paths={imagePaths} />
                </div>
            </div>
        );
    }

    return (
        <div id={`turn-${turn.seq}`} className="turn-row" title={turnTokenUsageTitle(turn)} style={gridStyle}>
            {seqGutter}
            <TurnHeader turn={turn} style={s} extras={headerExtras} rightSlot={inspectingBadge} />
            <div style={{ gridColumn: "2", minWidth: 0, maxWidth: "92ch" }}>
                {childrenSpawnedHere && childrenSpawnedHere.length > 0 ? (
                    <div style={{ padding: "2px 0 4px" }}>
                        {childrenSpawnedHere.map((c) => (
                            <SpawnMarker key={c.session_id} child={c} />
                        ))}
                    </div>
                ) : null}
                {turn.semantic_role === "tool_result" ? (
                    <ToolResultView text={turn.raw_text ?? ""} />
                ) : turn.content ? (
                    <>
                        <AliasMiniMap
                            content={turn.content}
                            activeTarget={activeTarget}
                            setActiveTarget={setActiveTarget}
                        />
                        <AnnotatedRawText
                            content={turn.content}
                            rawText={turnText(turn)}
                            activeTarget={activeTarget}
                            setActiveTarget={setActiveTarget}
                            maxHeight={400}
                        />
                    </>
                ) : (
                    <pre style={{ margin: 0, padding: "2px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "12.5px/1.55 ui-monospace, monospace", maxHeight: 400, overflow: "auto" }}>
                        {turn.spans.map((sp, i) => <Span key={i} span={sp} />)}
                    </pre>
                )}
                {turn.tool_calls && turn.tool_calls.length > 0
                    ? <ToolRow calls={turn.tool_calls} resultFor={resultFor} skillContentFor={skillContentFor} />
                    : null}
                <TurnImages paths={imagePaths} />
            </div>
        </div>
    );
}

/** Memoized: per-turn dissection is expensive; only re-render when this turn's
 *  own props change (not on every parent hover/scroll/hash update). */
export const Turn = memo(TurnImpl);

export function SessionInspectRoute() {
    const { sessionId } = useParams({ from: "/sessions/$sessionId/inspect" });
    return <SessionInspectView sessionId={sessionId} />;
}

export function SessionInspectView({ sessionId }: { readonly sessionId: string }) {
    const decoded = decodeURIComponent(sessionId);
    const queryClient = useQueryClient();

    // Server-side pagination. Initial fetch pulls metadata + first PAGE_SIZE
    // turns (small payload). Subsequent pages append to the in-memory copy.
    const PAGE_SIZE = 100;
    const baseKey = ["session-inspect", decoded] as const;
    const query = useQuery({
        queryKey: baseKey,
        queryFn: () => api.sessionInspect(decoded, { turnOffset: 0, turnLimit: PAGE_SIZE }),
    });
    const data = query.data ?? null;
    const [appendLoading, setAppendLoading] = useState(false);
    // Synchronous re-entrancy guard. `appendLoading` state lags behind rapid
    // async callers (IntersectionObserver + jump button can both pass the
    // state check before React commits), so we flip a ref synchronously and
    // gate on that.
    const loadingRef = useRef(false);

    // Deep-link to a specific turn via #turn-N (set by URL, page load, or
    // programmatically by the filter bar). Re-read on every hashchange so
    // jump buttons can move the cursor and re-trigger scroll/auto-load.
    const readHashSeq = (): number | null => {
        if (typeof window === "undefined") return null;
        const m = window.location.hash.match(/^#turn-(\d+)$/);
        return m ? Number(m[1]) : null;
    };
    const [anchoredSeq, setAnchoredSeq] = useState<number | null>(() => readHashSeq());
    // Zoom level. Default to the timeline: it's the fast highlight overview
    // (~2-3s) and the right entry point; the raw transcript is a slower
    // (large-query) drill-down loaded on demand.
    const [view, setView] = useState<"transcript" | "timeline">("timeline");

    // The docked right-rail inspector tracks the last block/alias the user
    // hovered, across all turns (seeded to the first parsed turn).
    const [selection, setSelection] = useInspectSelection(data);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const onHashChange = () => setAnchoredSeq(readHashSeq());
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);

    /** Fetch the next page of turns and append them to the cached payload. */
    const loadMore = async (count: number = PAGE_SIZE) => {
        if (!data) return;
        if (data.turns.length >= data.total_turns) return;
        // Synchronous ref check beats `appendLoading` state which is stale
        // across rapid back-to-back callers in the same tick.
        if (loadingRef.current) return;
        loadingRef.current = true;
        setAppendLoading(true);
        try {
            const page = await api.sessionInspect(decoded, {
                turnOffset: data.turns.length,
                turnLimit: count,
            });
            queryClient.setQueryData<typeof data>(baseKey, (prev) => {
                if (!prev) return prev;
                // Hook fires are server-windowed by the turn slice ts range,
                // so each page returns a different subset. Merge by idx
                // (stable across pages) and re-sort to keep render order
                // deterministic.
                const byIdx = new Map<number, typeof prev.hook_fires[number]>();
                for (const h of prev.hook_fires) byIdx.set(h.idx, h);
                for (const h of page.hook_fires) byIdx.set(h.idx, h);
                const mergedHooks = [...byIdx.values()].sort((a, b) => a.idx - b.idx);
                return {
                    ...prev,
                    turns: [...prev.turns, ...page.turns],
                    turn_window: { offset: 0, limit: prev.turns.length + page.turns.length },
                    hook_fires: mergedHooks,
                };
            });
        } finally {
            loadingRef.current = false;
            setAppendLoading(false);
        }
    };

    // If the user deep-linked to a turn past the loaded set, request enough
    // pages to include it before scrolling.
    useEffect(() => {
        if (anchoredSeq == null || !data) return;
        if (anchoredSeq < data.turns.length) return;
        const needed = anchoredSeq + 20 - data.turns.length;
        void loadMore(Math.max(needed, PAGE_SIZE));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anchoredSeq, data]);

    useEffect(() => {
        if (anchoredSeq == null || !data) return;
        const el = document.getElementById(`turn-${anchoredSeq}`);
        if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
    }, [anchoredSeq, data]);

    // Refs that always reflect the latest values - used by FilterBar handlers
    // that need to read state after `await loadMore()` resolves.
    const turnsRef = useRef<ReadonlyArray<InspectTurnDto>>(data?.turns ?? []);
    turnsRef.current = data?.turns ?? [];
    const anchoredSeqRef = useRef<number | null>(anchoredSeq);
    anchoredSeqRef.current = anchoredSeq;
    const hookFireIdxsRef = useRef<ReadonlyArray<number>>([]);
    hookFireIdxsRef.current = data?.hook_fires.map((h) => h.idx) ?? [];

    // Anchor seqs for the "next spawn" filter, recomputed when children change.
    const anchorSeqs = useMemo(
        () => spawnAnchorSet(data?.children ?? []),
        [data?.children],
    );
    const childrenByTurn = useMemo(
        () => childrenByAnchorTurn(data?.children ?? []),
        [data?.children],
    );
    const visibleSeq = useVisibleTurnSeq(data?.turns ?? [], anchoredSeq ?? data?.turns[0]?.seq ?? null);

    // IntersectionObserver on a sentinel triggers the next page load.
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!data) return;
        if (data.turns.length >= data.total_turns) return;
        const el = sentinelRef.current;
        if (!el) return;
        const obs = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting) void loadMore();
            }
        }, { rootMargin: "400px 0px" });
        obs.observe(el);
        return () => obs.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data?.turns.length, data?.total_turns]);

    return (
        <section className="panel">
            <header>
                <h2>Session inspect</h2>
                <span className="meta" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 5, overflow: "hidden" }}>
                        {(["timeline", "transcript"] as const).map((v) => (
                            <button
                                key={v}
                                type="button"
                                onClick={() => setView(v)}
                                style={{
                                    fontFamily: "ui-monospace, monospace", fontSize: 11, padding: "2px 10px", cursor: "pointer",
                                    border: "none", background: view === v ? "var(--ink)" : "var(--panel)", color: view === v ? "var(--panel)" : "var(--muted)",
                                }}
                            >{v}</button>
                        ))}
                    </span>
                    <code>{shortSessionId(decoded)}…</code>
                </span>
            </header>
            {view === "timeline" ? <SessionTimelineView sessionId={decoded} /> : null}
            {view === "transcript" && query.error ? <div className="error">Error: {String(query.error)}</div> : null}
            {view === "transcript" && query.isLoading && !data ? <div className="loading">Loading…</div> : null}
            {view === "transcript" && data ? (
                <Transcript
                    data={data}
                    anchoredSeq={anchoredSeq}
                    selection={selection}
                    setSelection={setSelection}
                    visibleSeq={visibleSeq}
                    filterBar={{
                        turns: data.turns,
                        anchorSeqs,
                        loadedCount: data.turns.length,
                        totalCount: data.total_turns,
                        appendLoading,
                        loadMore,
                        getTurns: () => turnsRef.current,
                        getCurrentSeq: () => anchoredSeqRef.current,
                        hookFireIdxs: data.hook_fires.map((h) => h.idx),
                        getHookFireIdxs: () => hookFireIdxsRef.current,
                        totalHookFires: data.total_hook_fires,
                    }}
                    childrenSpawnedHereForTurn={(seq) => childrenByTurn.get(seq)}
                    header={
                        <>
                            <div style={{ padding: "8px 24px", color: "var(--muted)", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                                <span>project: </span>
                                {data.project ? (
                                    <Link to="/projects/$slug" params={{ slug: data.project }} style={{ color: "var(--blue)", fontWeight: 600 }}>
                                        {sessionProjectLabel(data.project, data.cwd)}
                                    </Link>
                                ) : (
                                    <strong style={{ color: "var(--ink)" }}>{sessionProjectLabel(data.project, data.cwd)}</strong>
                                )}
                                {" · "}
                                {data.turns.length} turns · {data.total_chars.toLocaleString()} chars
                                {data.total_hook_fires > 0 ? (
                                    <> · <span style={{ color: "color-mix(in srgb, var(--green) 45%, var(--ink))" }}>{data.total_hook_fires} hook decision{data.total_hook_fires === 1 ? "" : "s"}</span></>
                                ) : null}
                                {" · source: "}<code>{data.source_path}</code>
                            </div>
                            {data.children.length > 0 ? (
                                <div style={{ padding: "6px 24px", background: "color-mix(in srgb, var(--rose) 8%, var(--panel))", borderTop: "1px solid color-mix(in srgb, var(--rose) 25%, var(--panel))", borderBottom: "1px solid color-mix(in srgb, var(--rose) 25%, var(--panel))", fontSize: 12 }}>
                                    <strong style={{ color: "var(--rose)" }}>↓ spawned {data.children.length} subagent{data.children.length === 1 ? "" : "s"}</strong>
                                    <span style={{ marginLeft: 12, color: "var(--rose)", opacity: 0.7 }}>
                                        {data.children.slice(0, 6).map((c, i) => {
                                            // Wire seam: c.session_id is already bare.
                                            const bare = c.session_id;
                                            return (
                                                <span key={c.session_id}>
                                                    {i > 0 ? " · " : " "}
                                                    <Link
                                                        to="/sessions/$sessionId/inspect"
                                                        params={{ sessionId: bare }}
                                                        style={{ color: "var(--rose)", fontFamily: "ui-monospace, monospace" }}
                                                    >
                                                        {c.nickname ? `"${c.nickname}"` : `${bare.slice(0, 10)}…`}
                                                    </Link>
                                                </span>
                                            );
                                        })}
                                        {data.children.length > 6 ? <span> · …+{data.children.length - 6}</span> : null}
                                    </span>
                                </div>
                            ) : null}
                            {data.parent_session ? (
                                <div style={{ padding: "6px 24px", background: "color-mix(in srgb, var(--rose) 8%, var(--panel))", borderTop: "1px solid color-mix(in srgb, var(--rose) 25%, var(--panel))", borderBottom: "1px solid color-mix(in srgb, var(--rose) 25%, var(--panel))", fontSize: 12 }}>
                                    <strong style={{ color: "var(--rose)" }}>↑ spawned by</strong>
                                    {" "}
                                    <Link
                                        to="/sessions/$sessionId/inspect"
                                        params={{ sessionId: data.parent_session }}
                                        style={{ color: "var(--rose)", fontWeight: 600, fontFamily: "ui-monospace, monospace" }}
                                    >
                                        {shortSessionId(data.parent_session)}…
                                    </Link>
                                    {data.parent_nickname ? <span style={{ color: "var(--rose)", marginLeft: 8 }}>· nickname: <strong>{data.parent_nickname}</strong></span> : null}
                                    <span style={{ color: "var(--rose)", marginLeft: 8, opacity: 0.7 }}>This is a subagent session.</span>
                                </div>
                            ) : null}
                        </>
                    }
                    renderAfterTurns={() =>
                        data.turns.length < data.total_turns ? (
                            <div
                                ref={sentinelRef}
                                style={{
                                    padding: "12px 24px", color: "#64748b", fontSize: 12, fontFamily: "ui-monospace, monospace",
                                    textAlign: "center", borderTop: "1px dashed #e2e8f0",
                                }}
                            >
                                {appendLoading
                                    ? `loading next ${PAGE_SIZE} of ${data.total_turns.toLocaleString()}…`
                                    : `loaded ${data.turns.length.toLocaleString()} of ${data.total_turns.toLocaleString()} turns ·`}
                                {!appendLoading ? (
                                    <>
                                        {" "}
                                        <button
                                            onClick={() => void loadMore(200)}
                                            style={{
                                                padding: "2px 10px", marginLeft: 6, fontSize: 11, border: "1px solid #e2e8f0",
                                                background: "#fff", color: "#475569", borderRadius: 4, cursor: "pointer",
                                            }}
                                        >load 200 more</button>
                                        {" "}
                                        <button
                                            onClick={() => void loadMore(data.total_turns - data.turns.length)}
                                            style={{
                                                padding: "2px 10px", fontSize: 11, border: "1px solid #e2e8f0",
                                                background: "#fff", color: "#475569", borderRadius: 4, cursor: "pointer",
                                            }}
                                        >load all</button>
                                    </>
                                ) : null}
                            </div>
                        ) : null
                    }
                />
            ) : null}
        </section>
    );
}
