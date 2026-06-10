import type { AxSessionShare } from "./artifact.ts";
import { type GistRef, shareUrlForGist } from "./gist.ts";

const formatUsd = (value: number): string =>
    value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;

/**
 * Sum a per-session token_usage field across this session and every spawned
 * subagent, recursively. Returns null when no session in the tree carries it.
 */
const sumTrace = (
    artifact: AxSessionShare,
    read: (usage: NonNullable<AxSessionShare["token_usage"]>) => number | null | undefined,
): number | null => {
    const own = artifact.token_usage ? read(artifact.token_usage) ?? null : null;
    const childValues = (artifact.children ?? []).map((child) => sumTrace(child, read));
    const values = [own, ...childValues].filter((v): v is number => v !== null);
    if (values.length === 0) return null;
    return values.reduce((sum, v) => sum + v, 0);
};

/**
 * Whole-trace estimated cost: this session plus every spawned subagent,
 * recursively. Returns null when no session in the tree carries a cost.
 */
export function totalCostUsd(artifact: AxSessionShare): number | null {
    return sumTrace(artifact, (u) => u.estimated_cost_usd);
}

/** Whole-trace estimated token count (cost-independent usage fallback). */
export function totalEstimatedTokens(artifact: AxSessionShare): number | null {
    return sumTrace(artifact, (u) => u.estimated_tokens);
}

const hasSessionUsage = (artifact: AxSessionShare): boolean => {
    if (!artifact.token_usage) return false;
    const { estimated_cost_usd, estimated_tokens } = artifact.token_usage;
    if (typeof estimated_cost_usd === "number" && estimated_cost_usd > 0) return true;
    if (typeof estimated_tokens === "number" && estimated_tokens > 0) return true;
    return false;
};

const hasTurnUsage = (artifact: AxSessionShare): boolean => {
    if (artifact.turns.some((turn) => turn.token_usage != null)) return true;
    return (artifact.children ?? []).some(hasTurnUsage);
};

/**
 * Returns true when the exported tree has session-level cost/token usage but
 * no per-turn usage rows anywhere in the root or descendants. That means the
 * cost rails will render as $0 on a per-turn basis. Callers should warn the
 * user to re-ingest with AX_REDERIVE_CLAUDE=1 AX_REDERIVE_SUBAGENTS=1.
 */
export function hasStaleUsage(artifact: AxSessionShare): boolean {
    const anySession = hasSessionUsage(artifact) ||
        (artifact.children ?? []).some(hasSessionUsage);
    if (!anySession) return false;
    return !hasTurnUsage(artifact);
}

export function formatSharePreview(
    artifact: AxSessionShare,
    options: { readonly public?: boolean } = {},
): string {
    const lines = [
        `Session ${artifact.session.id}`,
        `source: ${artifact.session.source}`,
    ];

    if (artifact.session.model !== undefined) {
        lines.push(`model: ${artifact.session.model}`);
    }

    if (artifact.session.project !== undefined) {
        lines.push(`project: ${artifact.session.project}`);
    }

    lines.push(
        `stats: turns: ${artifact.stats.turns}, tool_calls: ${artifact.stats.tool_calls}, files_changed: ${artifact.stats.files_changed}, skills_used: ${artifact.stats.skills_used}, failures: ${artifact.stats.failures}`,
    );

    const subagentCount = artifact.children?.length ?? 0;
    if (subagentCount > 0) {
        lines.push(`subagents: ${subagentCount}`);
    }

    const cost = totalCostUsd(artifact);
    if (cost !== null) {
        lines.push(`cost: ${formatUsd(cost)}`);
    } else {
        const tokens = totalEstimatedTokens(artifact);
        if (tokens !== null) {
            lines.push(`tokens: ~${tokens.toLocaleString("en-US")} (cost unavailable)`);
        }
    }

    lines.push(
        artifact.redactions.applied
            ? `redactions: applied (${artifact.redactions.rules.length} rules)`
            : "redactions: none",
        `publish target: ${options.public === true ? "public" : "secret/unlisted"} Gist`,
    );

    return lines.join("\n");
}

export function formatShareSuccess(ref: GistRef): string {
    return [
        "Published session share:",
        shareUrlForGist(ref),
    ].join("\n");
}
