import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "../api.ts";
import type { HookFireDto, InspectSpanDto, InspectSpanKind, InspectTurnDto, SessionInspectPayload, SessionTokenUsageDetail, TurnTokenUsageDetail } from "@shared/dashboard-types.ts";
import { childrenByAnchorTurn, spawnAnchorSet, turnText } from "./inspector-filters.ts";
import { spliceHookFires } from "@shared/hook-fire-splice.ts";
import { FilterBar } from "./inspector-filter-bar.tsx";
import { shortSessionId } from "@shared/session-id.ts";
import { sessionProjectLabel } from "@shared/project-slug.ts";
import type { InspectContentAtomDto, InspectContentBlockDto, InspectTurnContentDto } from "@shared/dashboard-types.ts";

interface KindStyle { bg: string; fg: string; bar: string; label: string }
export const KIND_STYLE: Record<InspectSpanKind, KindStyle> = {
    user_input:            { bg: "#fef9c3", fg: "#78350f", bar: "#eab308", label: "user input" },
    assistant_text:        { bg: "#f3f4f6", fg: "#111827", bar: "#0f172a", label: "assistant text" },
    tool_use:              { bg: "#ede9fe", fg: "#4c1d95", bar: "#8b5cf6", label: "tool use" },
    skill_context:         { bg: "#dbeafe", fg: "#1e3a8a", bar: "#3b82f6", label: "skill" },
    system_context:        { bg: "#e5e7eb", fg: "#1f2937", bar: "#64748b", label: "system" },
    wrapper_instruction:   { bg: "#fde68a", fg: "#92400e", bar: "#f59e0b", label: "wrapper" },
    hook_injection:        { bg: "#bbf7d0", fg: "#065f46", bar: "#10b981", label: "hook" },
    tool_result:           { bg: "#e9d5ff", fg: "#5b21b6", bar: "#a855f7", label: "tool result" },
    subagent_notification: { bg: "#fed7aa", fg: "#9a3412", bar: "#f97316", label: "subagent notif" },
    subagent_task:         { bg: "#ffe4e6", fg: "#9f1239", bar: "#e11d48", label: "subagent task" },
    pasted_reference:      { bg: "#fecaca", fg: "#7f1d1d", bar: "#ef4444", label: "pasted" },
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
    progress_visibility:   { bg: "#dbeafe", fg: "#1e3a8a", bar: "#3b82f6", label: "progress" },
    work_from_evidence:    { bg: "#ccfbf1", fg: "#115e59", bar: "#14b8a6", label: "evidence" },
    environment_context:   { bg: "#e0f2fe", fg: "#075985", bar: "#0284c7", label: "environment" },
    permissions:           { bg: "#e5e7eb", fg: "#1f2937", bar: "#64748b", label: "permissions" },
    agent_guidance:        { bg: "#f5f3ff", fg: "#5b21b6", bar: "#8b5cf6", label: "agent guidance" },
    skills_manifest:       { bg: "#dbeafe", fg: "#1e3a8a", bar: "#2563eb", label: "skills" },
    apps_manifest:         { bg: "#ecfccb", fg: "#3f6212", bar: "#84cc16", label: "apps" },
    plugins_manifest:      { bg: "#fce7f3", fg: "#9d174d", bar: "#ec4899", label: "plugins" },
    tool_call:             { bg: "#ede9fe", fg: "#4c1d95", bar: "#8b5cf6", label: "tool call" },
    tool_output:           { bg: "#e9d5ff", fg: "#5b21b6", bar: "#a855f7", label: "tool output" },
    plan:                  { bg: "#cffafe", fg: "#155e75", bar: "#06b6d4", label: "plan" },
    todo:                  { bg: "#fef9c3", fg: "#713f12", bar: "#ca8a04", label: "todo" },
    verification:          { bg: "#dcfce7", fg: "#14532d", bar: "#16a34a", label: "verification" },
    reference:             { bg: "#f1f5f9", fg: "#334155", bar: "#64748b", label: "reference" },
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
    return [
        usage.estimated_input_cost_usd,
        usage.estimated_cache_creation_cost_usd,
        usage.estimated_cache_read_cost_usd,
        usage.estimated_output_cost_usd,
    ].reduce((sum, value) => sum + (numberOrNull(value) ?? 0), 0);
}

function costBarSegments(usage: SessionTokenUsageDetail): ReadonlyArray<{ label: string; value: number | null; color: string }> {
    return [
        { label: "fresh input", value: numberOrNull(usage.estimated_input_cost_usd), color: "#2567a8" },
        { label: "cache write", value: numberOrNull(usage.estimated_cache_creation_cost_usd), color: "#f59e0b" },
        { label: "cache read", value: numberOrNull(usage.estimated_cache_read_cost_usd), color: "#10b981" },
        { label: "output", value: numberOrNull(usage.estimated_output_cost_usd), color: "#8b5cf6" },
    ];
}

function usageTokenLine(usage: TurnTokenUsageDetail): string {
    const parts = [
        `${fmtCount(usage.estimated_tokens)} tok`,
        usage.fresh_input_tokens !== null ? `${fmtCount(usage.fresh_input_tokens)} fresh` : null,
        usage.cache_read_input_tokens !== null ? `${fmtCount(usage.cache_read_input_tokens)} cached` : null,
        usage.completion_tokens !== null ? `${fmtCount(usage.completion_tokens)} out` : null,
    ].filter((part): part is string => part !== null);
    return parts.join(" · ");
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
    if (kind.includes("system") || kind.includes("instruction")) return { bg: "#e5e7eb", fg: "#1f2937", bar: "#64748b", label: "system" };
    if (kind.includes("environment") || kind.includes("context")) return { bg: "#dbeafe", fg: "#1e3a8a", bar: "#2563eb", label: "context" };
    if (kind.includes("objective") || kind.includes("goal")) return { bg: "#dcfce7", fg: "#166534", bar: "#22c55e", label: "objective" };
    if (kind.includes("budget") || kind.includes("metric")) return { bg: "#ffedd5", fg: "#9a3412", bar: "#f97316", label: "budget" };
    if (kind.includes("assistant")) return { bg: "#cffafe", fg: "#155e75", bar: "#06b6d4", label: "assistant" };
    if (kind.includes("tool")) return { bg: "#ede9fe", fg: "#4c1d95", bar: "#8b5cf6", label: "tool" };
    if (kind.includes("hook")) return { bg: "#bbf7d0", fg: "#065f46", bar: "#10b981", label: "hook" };
    if (kind.includes("code")) return { bg: "#f1f5f9", fg: "#334155", bar: "#475569", label: "code" };
    if (kind.includes("heading")) return { bg: "#fee2e2", fg: "#991b1b", bar: "#ef4444", label: "heading" };
    if (kind.includes("paragraph")) return { bg: "#fef9c3", fg: "#78350f", bar: "#eab308", label: "paragraph" };
    return { bg: "#f8fafc", fg: "#334155", bar: "#94a3b8", label: blockLabel(kind) };
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
    if (atom.kind.includes("file")) return { bg: "#eff6ff", fg: "#1d4ed8", bar: "#3b82f6", label: "file" };
    if (atom.kind.includes("url") || atom.kind.includes("citation")) return { bg: "#ecfeff", fg: "#0e7490", bar: "#06b6d4", label: "link" };
    if (atom.kind.includes("symbol")) return { bg: "#f0fdf4", fg: "#15803d", bar: "#22c55e", label: "symbol" };
    if (atom.kind.includes("command")) return { bg: "#fef3c7", fg: "#92400e", bar: "#f59e0b", label: "command" };
    return { bg: "#f8fafc", fg: "#334155", bar: "#94a3b8", label: blockLabel(atom.kind) };
}

function semanticAliasCounts(content: InspectTurnContentDto): Array<{ alias: string; label: string; count: number; tone: ContentTone }> {
    const aliases = visibleTextBlocks(content)
        .map((block) => primarySectionAlias(block))
        .filter((alias): alias is InspectContentAtomDto => alias !== null);
    const hasStructuralAlias = aliases.some((alias) => alias.value !== "reference");
    const counts = new Map<string, { label: string; count: number; tone: ContentTone }>();
    for (const alias of aliases) {
        if (hasStructuralAlias && alias.value === "reference") continue;
        const style = ALIAS_STYLE[alias.value] ?? ALIAS_STYLE.reference;
        const existing = counts.get(alias.value) ?? { label: aliasLabel(alias), count: 0, tone: { ...style, label: aliasLabel(alias) } };
        counts.set(alias.value, { ...existing, count: existing.count + 1 });
    }
    return [...counts.entries()]
        .map(([alias, value]) => ({ alias, ...value }))
        .sort((a, b) => b.count - a.count);
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
    const blocks = hasStructuralAlias
        ? aliasBlocks.filter((entry) => entry.alias.value !== "reference")
        : aliasBlocks;
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
            border: "1px solid #cfd8d4",
            background: "#f8fafc",
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
                        style={{ color: "#64748b", font: "11px/1.4 ui-monospace, monospace" }}
                    >
                        {fmtCount(usage.estimated_tokens)} tokens · {usage.model ?? "unknown model"}
                    </span>
                </div>
                <span style={{ color: "#64748b", font: "10px/1.4 ui-monospace, monospace" }}>
                    structure % = character share · hover metrics for definitions
                </span>
            </div>
            <div
                title={`Cost mix by provider billing component. Pricing: ${usage.pricing_source ?? "unknown"}. Per-turn headers below use turn usage when available; inspector block/span cost is character-allocated within the selected turn.`}
                style={{
                    height: 8,
                    border: "1px solid #cfd8d4",
                    background: gradient ? `linear-gradient(90deg, ${gradient})` : "#e5e7eb",
                }}
            />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {segments.map((segment) => (
                    <span
                        key={segment.label}
                        title={`${segment.label}: ${fmtUsd(segment.value)} (${pctOf(segment.value, breakdownTotal || totalCost)} of known cost components)`}
                        style={{
                            background: "#fff",
                            color: "#334155",
                            border: "1px solid #e2e8f0",
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
        ["fresh", progress.freshInputCostUsd, "#2567a8", "Fresh input billed at normal input price."],
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
            border: "1px solid #d8dee8",
            background: "#f8fafc",
            fontFamily: "ui-monospace, monospace",
            color: "#334155",
        }}>
            <div style={{ padding: "8px 9px", borderBottom: "1px solid #e2e8f0" }}>
                <div style={{ color: "#64748b", font: "700 10px/1.2 ui-monospace, monospace", textTransform: "uppercase" }}>
                    cost so far
                </div>
                <div
                    title="Exact provider token usage summed through the currently visible turn. Missing transcript rows are not estimated in this rail."
                    style={{ marginTop: 6, color: "#111827", font: "700 20px/1 ui-monospace, monospace" }}
                >
                    {fmtUsd(progress.totalCostUsd)}
                </div>
                <div style={{ marginTop: 5, color: "#64748b", font: "10px/1.35 ui-monospace, monospace" }}>
                    through #{currentSeq ?? "-"} · {progressPct} of session
                </div>
            </div>
            <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "5px 8px", margin: 0, padding: "8px 9px", font: "10px/1.25 ui-monospace, monospace" }}>
                <dt style={{ color: "#64748b" }}>exact turns</dt>
                <dd style={{ margin: 0, fontWeight: 700 }}>{progress.exactTurns}/{exactTurnCount}</dd>
                <dt style={{ color: "#64748b" }}>tokens</dt>
                <dd style={{ margin: 0, fontWeight: 700 }}>{fmtCount(progress.estimatedTokens)}</dd>
                <dt style={{ color: "#64748b" }}>session total</dt>
                <dd style={{ margin: 0, fontWeight: 700 }}>{fmtUsd(sessionCost)}</dd>
            </dl>
            <div style={{ display: "grid", gap: 5, padding: "0 9px 9px" }}>
                {rows.map(([label, value, color, title]) => (
                    <div
                        key={label}
                        title={title}
                        style={{ display: "flex", justifyContent: "space-between", gap: 8, border: "1px solid #e2e8f0", background: "#fff", borderLeft: `3px solid ${color}`, padding: "5px 6px", font: "10px/1.2 ui-monospace, monospace" }}
                    >
                        <span style={{ color: "#64748b" }}>{label}</span>
                        <strong>{fmtUsd(value)}</strong>
                    </div>
                ))}
            </div>
            <div style={{ borderTop: "1px solid #e2e8f0", padding: "7px 9px", color: "#64748b", font: "10px/1.35 ui-monospace, monospace" }}>
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
        <div style={{
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
                    border: "1px solid #d8dee8", background: "#f8fafc",
                    padding: 10, color: "#94a3b8",
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
            font: "11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace",
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
        <aside style={{ border: "1px solid #d8dee8", background: "#f8fafc", minWidth: 0, maxHeight, overflow: "auto" }}>
            <div style={{ padding: "8px 10px", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <strong style={{ color: "#334155", font: "700 10px/1 ui-monospace, monospace", textTransform: "uppercase" }}>
                    inspector{turnSeq != null ? ` · #${turnSeq}` : ""}
                </strong>
                <span style={{ color: "#94a3b8", font: "10px/1 ui-monospace, monospace" }}>
                    {content.parser_id}@{content.parser_version}
                </span>
            </div>
            {!block ? (
                <div style={{ padding: 10, color: "#94a3b8", font: "11px/1.5 ui-monospace, monospace" }}>No parsed block selected.</div>
            ) : (
                <div style={{ padding: 10, display: "grid", gap: 8 }}>
                    <div style={{ background: "#fff", border: "1px solid #e2e8f0", boxShadow: `inset 4px 0 0 ${family.bar}`, padding: "8px 9px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                            <strong style={{ color: family.fg, font: "700 11px/1 ui-monospace, monospace", textTransform: "uppercase" }}>
                                {displayBlockLabel(block)}
                            </strong>
                            <span style={{ color: "#94a3b8", font: "10px/1 ui-monospace, monospace" }}>
                                block #{block.seq}{block.parent_seq == null ? "" : ` / parent ${block.parent_seq}`}
                            </span>
                        </div>
                        <div style={{ marginTop: 6, color: "#64748b", font: "10px/1.3 ui-monospace, monospace" }}>
                            {block.kind} · {Math.round(block.confidence * 100)}% · {block.start_offset ?? "?"}-{block.end_offset ?? "?"}
                        </div>
                        {block.heading ? (
                            <div style={{ marginTop: 7, color: "#334155", font: "700 11px/1.35 ui-monospace, monospace" }}>{block.heading}</div>
                        ) : null}
                        <pre style={{ margin: "7px 0 0", color: "#334155", font: "11px/1.45 ui-monospace, monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                            {contentBrief(block.text_excerpt ?? block.text)}
                        </pre>
                    </div>

                    {turnUsage ? (
                        <div style={{ background: "#fff", border: "1px solid #e2e8f0", padding: "8px 9px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                                <strong style={{ color: "#334155", font: "700 10px/1 ui-monospace, monospace", textTransform: "uppercase" }}>
                                    estimated cost lens
                                </strong>
                                <span style={{ color: "#94a3b8", font: "10px/1 ui-monospace, monospace" }}>
                                    char-weighted
                                </span>
                            </div>
                            <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 8px", margin: "7px 0 0", font: "11px/1.35 ui-monospace, monospace" }}>
                                <dt style={{ color: "#64748b" }}>allocated block cost</dt>
                                <dd style={{ margin: 0, fontWeight: 700 }}>{fmtUsd(blockTotalCost)}</dd>
                                <dt style={{ color: "#64748b" }}>cache-read share</dt>
                                <dd style={{ margin: 0, fontWeight: 700 }}>{fmtUsd(blockCacheReadCost)}</dd>
                                <dt style={{ color: "#64748b" }}>block chars</dt>
                                <dd style={{ margin: 0 }}>{fmtCount(blockChars)}</dd>
                                <dt style={{ color: "#64748b" }}>turn tokens</dt>
                                <dd style={{ margin: 0 }}>{fmtCount(turnUsage.estimated_tokens)}</dd>
                            </dl>
                            <div style={{ marginTop: 6, color: "#64748b", fontSize: 11, lineHeight: 1.35 }}>
                                Turn usage is provider-derived; block/span cost is allocated by character share inside this turn.
                            </div>
                        </div>
                    ) : null}

                    {atom ? (
                        <AtomCard atom={atom} active />
                    ) : null}

                    <div>
                        <div style={{ color: "#64748b", font: "700 10px/1 ui-monospace, monospace", textTransform: "uppercase", marginBottom: 5 }}>
                            atoms in this block · {blockAtoms.length}
                        </div>
                        {blockAtoms.length === 0 ? (
                            <div style={{ color: "#94a3b8", font: "11px/1.5 ui-monospace, monospace" }}>No references or semantic atoms extracted.</div>
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
                        <div style={{ color: "#94a3b8", font: "10px/1.35 ui-monospace, monospace", borderTop: "1px solid #e2e8f0", paddingTop: 7 }}>
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
            border: `1px solid ${active ? tone.bar : "#e2e8f0"}`,
            boxShadow: `inset 3px 0 0 ${tone.bar}`,
            background: active ? tone.bg : "#fff",
            padding: compact ? "6px 7px" : "8px 9px",
        }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <strong style={{ color: tone.fg, font: "700 10px/1 ui-monospace, monospace", textTransform: "uppercase" }}>
                    {atomDisplayLabel(atom)}
                </strong>
                <span style={{ color: "#94a3b8", font: "10px/1 ui-monospace, monospace" }}>
                    {Math.round(atom.confidence * 100)}%
                </span>
            </div>
            <div style={{ marginTop: 4, color: "#334155", font: "11px/1.35 ui-monospace, monospace", overflowWrap: "anywhere" }}>
                {atom.normalized ?? atom.value}
            </div>
            {!compact && (method || matched) ? (
                <div style={{ marginTop: 5, color: "#64748b", font: "10px/1.35 ui-monospace, monospace" }}>
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

interface SpawnChildDto {
    readonly session_id: string;
    readonly nickname: string | null;
    readonly tool: string | null;
    readonly ts: string | null;
    readonly meta: SpawnMetaDto | null;
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
            margin: "4px 0", padding: "7px 10px", background: "#fff1f2",
            border: "1px solid #fecdd3", borderLeft: "4px solid #e11d48", borderRadius: 3, fontSize: 11,
            fontFamily: "ui-monospace, monospace", color: "#9f1239",
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>↳ child session spawned</span>
                <Link
                    to="/sessions/$sessionId/inspect"
                    params={{ sessionId: childBare }}
                    preload="intent"
                    style={{ color: "#9f1239", fontWeight: 600 }}
                >
                    {child.nickname ? `"${child.nickname}"` : `${childBare.slice(0, 12)}…`}
                </Link>
                {child.nickname ? <span style={{ opacity: 0.6 }}>{childBare.slice(0, 10)}…</span> : null}
                {child.tool ? <span style={{ opacity: 0.6 }}>via {child.tool}</span> : null}
                {m ? <span style={{ background: "#fecdd3", color: "#7f1d1d", padding: "0 6px", borderRadius: 2, fontSize: 10, fontWeight: 600 }}>{m.provider}</span> : null}
                {chips.map((c) => (
                    <span key={c.label} style={{ background: "#fee2e2", padding: "0 6px", borderRadius: 2, fontSize: 10 }}>
                        {c.label}: <strong>{c.value}</strong>
                    </span>
                ))}
                <span style={{ opacity: 0.6, marginLeft: "auto" }}>{ts}</span>
            </div>
            {brief ? (
                <div style={{ marginTop: 4, color: "#7f1d1d", opacity: 0.9, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    <span style={{ fontStyle: "italic" }}>
                        “{expanded || !briefIsLong ? brief : `${brief.slice(0, briefClippedLen - 1)}…`}”
                    </span>
                    {briefIsLong ? (
                        <button
                            onClick={() => setExpanded((v) => !v)}
                            style={{
                                marginLeft: 6, padding: "0 6px", fontSize: 10, fontFamily: "inherit",
                                background: "transparent", border: "1px solid #fecdd3", borderRadius: 3,
                                color: "#9f1239", cursor: "pointer",
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
function HookFireMarker({ hook }: { hook: HookFireDto }) {
    const ts = hook.ts ? new Date(hook.ts).toISOString().slice(11, 19) : "";
    const injectBg = hook.inject ? "#bbf7d0" : "#e2e8f0";
    const injectFg = hook.inject ? "#065f46" : "#475569";
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
                background: hook.inject ? "#ecfdf5" : "#f8fafc",
                borderRadius: 3, fontSize: 11,
                fontFamily: "ui-monospace, monospace", color: "#065f46",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600 }}>⚙ hook_fire</span>
                <span style={{ background: injectBg, color: injectFg, padding: "0 6px", borderRadius: 2, fontSize: 10, fontWeight: 600 }}>
                    inject: {hook.inject ? "yes" : "no"}
                </span>
                <span style={{ background: "#e0e7ff", color: "#3730a3", padding: "0 6px", borderRadius: 2, fontSize: 10 }}>
                    event: <strong>{hook.event}</strong>
                </span>
                <span style={{ background: "#fef3c7", color: "#92400e", padding: "0 6px", borderRadius: 2, fontSize: 10 }}>
                    reason: <strong>{hook.reason}</strong>
                </span>
                <span style={{ color: "#64748b", fontSize: 10 }}>{hook.latency_ms}ms</span>
                <span style={{ color: "#64748b", marginLeft: "auto" }}>{ts}</span>
            </div>
            <div style={{ marginTop: 3, color: "#475569", fontSize: 11, wordBreak: "break-all" }}>
                {filePathShort}
            </div>
            {hook.inject && hook.injected_titles.length > 0 ? (
                <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px dashed #a7f3d0", fontSize: 10, color: "#065f46" }}>
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

export function Turn({
    turn,
    anchored,
    childrenSpawnedHere,
    activeTarget,
    onInspect,
}: {
    turn: InspectTurnDto;
    anchored: boolean;
    childrenSpawnedHere?: ReadonlyArray<SpawnChildDto>;
    /** Non-null only when THIS turn owns the docked inspector's current target. */
    activeTarget: InspectTarget | null;
    /** Hover/click a block or alias to surface it in the docked rail inspector. */
    onInspect: (selection: InspectSelection) => void;
}) {
    const turnUsage = turn.token_usage ?? null;
    // Routes every block/alias hover+click up to the shared docked inspector,
    // tagged with this turn's content + usage so the rail can show cost lenses.
    const setActiveTarget = (target: InspectTarget | null) => {
        if (!turn.content) return;
        onInspect({ turnSeq: turn.seq, content: turn.content, target, turnUsage, turnChars: turn.char_count });
    };
    const s = KIND_STYLE[turn.semantic_role];
    const kindCounts = new Map<InspectSpanKind, number>();
    for (const sp of turn.spans) kindCounts.set(sp.kind, (kindCounts.get(sp.kind) ?? 0) + sp.text.length);
    const total = turn.char_count;
    const chips = [...kindCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, n]) => {
            const c = KIND_STYLE[kind];
            const pct = total > 0 ? ((n / total) * 100).toFixed(0) : "0";
            return (
                <span
                    key={kind}
                    title={`${c.label}: ${pct}% of this turn's characters. This is structure share, not token or billing share.`}
                    style={{ background: c.bg, color: c.fg, padding: "0 6px", borderRadius: 3, fontSize: 10, fontFamily: "ui-monospace, monospace" }}
                >
                    {c.label} {pct}%
                </span>
            );
        });
    const aliasChips = turn.content ? semanticAliasCounts(turn.content).slice(0, 8).map(({ alias, label, count, tone }) => (
        <span
            key={alias}
            title={`${label}: ${count} semantic block${count === 1 ? "" : "s"} detected inside this turn.`}
            style={{
                background: tone.bg,
                color: tone.fg,
                borderLeft: `3px solid ${tone.bar}`,
                padding: "0 6px",
                borderRadius: 3,
                fontSize: 10,
                fontFamily: "ui-monospace, monospace",
                fontWeight: 700,
            }}
        >
            {label} {count}
        </span>
    )) : [];
    const ts = turn.ts ? new Date(turn.ts).toISOString().slice(11, 19) : "";
    const sizeStr = turn.char_count > 1000 ? `${(turn.char_count / 1000).toFixed(1)}k` : `${turn.char_count}`;
    const turnCost = numberOrNull(turnUsage?.estimated_cost_usd);
    const spawnedChildCount = childrenSpawnedHere?.length ?? 0;
    const jsonlBadge = turn.role !== turn.semantic_role.replace(/_text$|_input$/, "")
        ? <span style={{ color: "#94a3b8", fontSize: 10 }}>(jsonl: {turn.role})</span>
        : null;
    return (
        <div
            id={`turn-${turn.seq}`}
            title={turnTokenUsageTitle(turn)}
            style={{
                display: "grid",
                gridTemplateColumns: "1fr",
                padding: "6px 24px",
                scrollMarginTop: JUMP_TARGET_SCROLL_MARGIN,
                borderLeft: `3px solid ${s.bar}`,
                background: anchored ? "#fef3c7" : "transparent",
                transition: "background 0.6s",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#64748b", flexWrap: "wrap", fontFamily: "ui-monospace, monospace" }}>
                <a href={`#turn-${turn.seq}`} style={{ color: "#94a3b8", textDecoration: "none", minWidth: 48 }}>#{turn.seq}</a>
                <span style={{ background: s.bg, color: s.fg, padding: "1px 8px", borderRadius: 3, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {s.label}
                </span>
                {spawnedChildCount > 0 ? (
                    <span style={{
                        background: "#ffe4e6", color: "#9f1239", border: "1px solid #fecdd3",
                        padding: "1px 8px", borderRadius: 3, fontWeight: 700, fontSize: 10,
                        textTransform: "uppercase",
                    }}>
                        spawned child x{spawnedChildCount}
                    </span>
                ) : null}
                {jsonlBadge}
                <span title="Turn timestamp from the source transcript." style={{ color: "#94a3b8" }}>{ts}</span>
                <span
                    title={`${sizeStr}c = ${turn.char_count.toLocaleString()} characters in this turn. ${turn.spans.length}span = ${turn.spans.length} classified message slice${turn.spans.length === 1 ? "" : "s"} from the raw transcript.`}
                    style={{ color: "#94a3b8" }}
                >
                    {sizeStr}c · {turn.spans.length}span
                </span>
                {turnUsage ? (
                    <span
                        title={turnTokenUsageTitle(turn)}
                        style={{ color: "#64748b" }}
                    >
                        {turnCost !== null ? fmtUsd(turnCost) : "cost ?"} · {usageTokenLine(turnUsage)}
                    </span>
                ) : null}
                {turn.content && activeTarget ? (
                    <span
                        title="This turn is showing in the docked inspector on the right."
                        style={{
                            padding: "1px 7px", border: "1px solid #0f172a", borderRadius: 3,
                            background: "#0f172a", color: "#fff",
                            font: "10px/1.4 ui-monospace, monospace",
                        }}
                    >
                        inspecting →
                    </span>
                ) : null}
                <span style={{ display: "inline-flex", gap: 3, flexWrap: "wrap", marginLeft: "auto" }}>
                    {aliasChips.length > 0 ? aliasChips : chips}
                </span>
            </div>
            {childrenSpawnedHere && childrenSpawnedHere.length > 0 ? (
                <div style={{ padding: "6px 0 2px" }}>
                    {childrenSpawnedHere.map((c) => (
                        <SpawnMarker key={c.session_id} child={c} />
                    ))}
                </div>
            ) : null}
            {turn.content ? (
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
                <pre style={{ margin: 0, padding: "4px 0 6px", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "12px/1.55 ui-monospace, monospace", maxHeight: 400, overflow: "auto" }}>
                    {turn.spans.map((sp, i) => <Span key={i} span={sp} />)}
                </pre>
            )}
        </div>
    );
}

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
                <span className="meta">
                    <code>{shortSessionId(decoded)}…</code>
                </span>
            </header>
            {query.error ? <div className="error">Error: {String(query.error)}</div> : null}
            {query.isLoading && !data ? <div className="loading">Loading…</div> : null}
            {data ? (
                <>
                    <div style={{ padding: "8px 24px", color: "#64748b", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                        <span>project: </span>
                        {data.project ? (
                            <Link to="/projects/$slug" params={{ slug: data.project }} style={{ color: "#2563eb", fontWeight: 600 }}>
                                {sessionProjectLabel(data.project, data.cwd)}
                            </Link>
                        ) : (
                            <strong style={{ color: "#334155" }}>{sessionProjectLabel(data.project, data.cwd)}</strong>
                        )}
                        {" · "}
                        {data.turns.length} turns · {data.total_chars.toLocaleString()} chars
                        {data.total_hook_fires > 0 ? (
                            <> · <span style={{ color: "#065f46" }}>{data.total_hook_fires} hook decision{data.total_hook_fires === 1 ? "" : "s"}</span></>
                        ) : null}
                        {" · source: "}<code>{data.source_path}</code>
                    </div>
                    {data.children.length > 0 ? (
                        <div style={{ padding: "6px 24px", background: "#ffe4e6", borderTop: "1px solid #fecdd3", borderBottom: "1px solid #fecdd3", fontSize: 12 }}>
                            <strong style={{ color: "#9f1239" }}>↓ spawned {data.children.length} subagent{data.children.length === 1 ? "" : "s"}</strong>
                            <span style={{ marginLeft: 12, color: "#9f1239", opacity: 0.7 }}>
                                {data.children.slice(0, 6).map((c, i) => {
                                    // Wire seam: c.session_id is already bare.
                                    const bare = c.session_id;
                                    return (
                                        <span key={c.session_id}>
                                            {i > 0 ? " · " : " "}
                                            <Link
                                                to="/sessions/$sessionId/inspect"
                                                params={{ sessionId: bare }}
                                                style={{ color: "#9f1239", fontFamily: "ui-monospace, monospace" }}
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
                        <div style={{ padding: "6px 24px", background: "#ffe4e6", borderTop: "1px solid #fecdd3", borderBottom: "1px solid #fecdd3", fontSize: 12 }}>
                            <strong style={{ color: "#9f1239" }}>↑ spawned by</strong>
                            {" "}
                            <Link
                                to="/sessions/$sessionId/inspect"
                                params={{ sessionId: data.parent_session }}
                                style={{ color: "#9f1239", fontWeight: 600, fontFamily: "ui-monospace, monospace" }}
                            >
                                {shortSessionId(data.parent_session)}…
                            </Link>
                            {data.parent_nickname ? <span style={{ color: "#9f1239", marginLeft: 8 }}>· nickname: <strong>{data.parent_nickname}</strong></span> : null}
                            <span style={{ color: "#9f1239", marginLeft: 8, opacity: 0.7 }}>This is a subagent session.</span>
                        </div>
                    ) : null}
                    <FilterBar
                        turns={data.turns}
                        anchorSeqs={anchorSeqs}
                        loadedCount={data.turns.length}
                        totalCount={data.total_turns}
                        appendLoading={appendLoading}
                        loadMore={loadMore}
                        getTurns={() => turnsRef.current}
                        getCurrentSeq={() => anchoredSeqRef.current}
                        hookFireIdxs={data.hook_fires.map((h) => h.idx)}
                        getHookFireIdxs={() => hookFireIdxsRef.current}
                        totalHookFires={data.total_hook_fires}
                    />
                    <InspectGuide data={data} />
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "4px 24px 8px" }}>
                        {(Object.keys(KIND_STYLE) as InspectSpanKind[]).map((kind) => {
                            const c = KIND_STYLE[kind];
                            const n = data.totals_by_kind[kind] ?? 0;
                            const pct = data.total_chars > 0 ? ((n / data.total_chars) * 100).toFixed(1) : "0";
                            return (
                                <span
                                    key={kind}
                                    title={`${c.label}: ${pct}% of exported characters in this session view. This is not token share or billing share.`}
                                    style={{ background: c.bg, color: c.fg, padding: "2px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, borderLeft: `3px solid ${c.bar}` }}
                                >
                                    {c.label} <em style={{ fontStyle: "normal", opacity: 0.7, fontWeight: 400 }}>{pct}%</em>
                                </span>
                            );
                        })}
                    </div>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                            {(() => {
                                const childrenByTurn = childrenByAnchorTurn(data.children);
                                const items = spliceHookFires(data.turns, data.hook_fires);
                                return items.map((item) => {
                                    if (item.kind === "hook_fire") {
                                        return <HookFireMarker key={`hook-${item.hook.idx}`} hook={item.hook} />;
                                    }
                                    const t = item.turn;
                                    return (
                                        <Turn
                                            key={`turn-${t.seq}`}
                                            turn={t}
                                            anchored={anchoredSeq === t.seq}
                                            childrenSpawnedHere={childrenByTurn.get(t.seq)}
                                            activeTarget={selection?.turnSeq === t.seq ? selection.target : null}
                                            onInspect={setSelection}
                                        />
                                    );
                                });
                            })()}
                            {data.turns.length < data.total_turns ? (
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
                            ) : null}
                        </div>
                        <DockedRail
                            data={data}
                            currentSeq={visibleSeq}
                            selection={selection}
                            setSelection={setSelection}
                        />
                    </div>
                </>
            ) : null}
        </section>
    );
}
