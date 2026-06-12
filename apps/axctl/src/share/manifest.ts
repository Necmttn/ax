import type { SessionTokenUsageDetail } from "@ax/lib/shared/dashboard-types";
import {
    AX_SESSION_SHARE_SCHEMA_VERSION,
    type AxSessionShare,
    type ShareSource,
} from "./artifact.ts";

/**
 * Multi-file gist bundle (schema v3). A shared session is published as ONE
 * gist containing:
 *   - `index.json`        -> {@link AxSessionShareManifest}
 *   - `session.json`      -> the root {@link AxSessionShare} (children stripped)
 *   - `subagent-<id>.json -> one {@link AxSessionShare} per descendant
 *
 * The manifest is small and loads instantly, so the viewer can render the
 * parent header + per-subagent metadata cards before fetching any heavy
 * transcript file. Each card carries enough to show "how much it cost, how
 * long it ran, how many steps" without opening the child.
 */
export const SHARE_MANIFEST_FILE = "index.json" as const;
export const SHARE_ROOT_FILE = "session.json" as const;
export const SHARE_NARRATION_FILE = "narration.json" as const;
export const AX_SESSION_SHARE_MANIFEST_SCHEMA_VERSION = 5 as const;
export const SUPPORTED_SHARE_MANIFEST_SCHEMA_VERSIONS = [3, 4, 5] as const;

export interface ShareNarrationArtifact {
    readonly schema_version: number;
    readonly kind: "narration";
    readonly [key: string]: unknown;
}

/** Filename for a descendant's full share, derived from its session id. */
export function subagentFileName(sessionId: string): string {
    const slug = sessionId.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    return `subagent-${slug.length > 0 ? slug : "child"}.json`;
}

export interface ShareManifestStats {
    readonly turns: number;
    readonly tool_calls: number;
    readonly files_changed: number;
    readonly skills_used: number;
    readonly failures: number;
}

/** One descendant summary card - everything the listing needs, no transcript. */
export interface ShareSubagentCard {
    readonly id: string;
    /** Gist filename holding this subagent's full share. */
    readonly file: string;
    /** Direct parent session id; null only for a malformed tree. */
    readonly parent_id: string | null;
    /** 1 for a direct child of the root, 2 for a grandchild, etc. */
    readonly depth: number;
    /** Turn seq in the PARENT session where this subagent was spawned, if known. */
    readonly spawn_turn_seq: number | null;
    readonly source: ShareSource;
    readonly model?: string;
    readonly started_at?: string;
    readonly ended_at?: string;
    readonly duration_ms: number | null;
    readonly stats: ShareManifestStats;
    readonly cost_usd: number | null;
    readonly estimated_tokens: number | null;
    /** Short identifying label (first user task turn, truncated). */
    readonly task_label?: string;
    readonly had_error: boolean;
}

/** Whole-trace rollup across the root + every descendant. */
export interface ShareTotals {
    readonly cost_usd: number | null;
    readonly duration_ms: number | null;
    readonly tool_calls: number;
    readonly turns: number;
    /** Total descendant count (all depths). */
    readonly subagents: number;
    readonly failures: number;
}

export interface AxSessionShareManifest {
    readonly schema_version: typeof AX_SESSION_SHARE_SCHEMA_VERSION | typeof AX_SESSION_SHARE_MANIFEST_SCHEMA_VERSION;
    readonly kind: "manifest";
    readonly exported_at: string;
    readonly ax_version: string;
    readonly session: AxSessionShare["session"];
    readonly stats: ShareManifestStats;
    readonly token_usage?: SessionTokenUsageDetail | null;
    /** Filename of the root session's full share. */
    readonly root_file: typeof SHARE_ROOT_FILE;
    /** v5 additive: optional generated narration artifact in this gist. */
    readonly narration_file?: typeof SHARE_NARRATION_FILE;
    readonly totals: ShareTotals;
    readonly subagents: ReadonlyArray<ShareSubagentCard>;
    readonly redactions: AxSessionShare["redactions"];
}

/** One gist file: a name plus its parsed JSON payload. */
export interface ShareBundleFile {
    readonly name: string;
    readonly content: AxSessionShare | AxSessionShareManifest | ShareNarrationArtifact;
}

/** The complete multi-file bundle ready to publish or print. */
export interface ShareBundle {
    readonly manifest: AxSessionShareManifest;
    readonly files: ReadonlyArray<ShareBundleFile>;
}

const durationMs = (start?: string, end?: string): number | null => {
    if (!start || !end) return null;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

const TASK_LABEL_MAX = 80;

/** First user "task" turn text, collapsed + truncated, for a card label. */
export function deriveShareTaskLabel(share: AxSessionShare): string | undefined {
    const task = share.turns.find(
        (t) => t.role === "user" && (t.message_kind === "task" || t.message_kind === undefined),
    );
    const raw = (task?.text ?? share.session.summary ?? "").replace(/\s+/g, " ").trim();
    if (raw.length === 0) return undefined;
    return raw.length > TASK_LABEL_MAX ? `${raw.slice(0, TASK_LABEL_MAX - 1)}…` : raw;
}

/** Drop nested `children` from a share so each emitted file is self-contained. */
const withoutChildren = (share: AxSessionShare): AxSessionShare => {
    if (!share.children) return share;
    const { children: _children, ...rest } = share;
    return rest;
};

const cardFor = (share: AxSessionShare, parentId: string | null, depth: number): ShareSubagentCard => {
    const taskLabel = deriveShareTaskLabel(share);
    return {
        id: share.session.id,
        file: subagentFileName(share.session.id),
        parent_id: parentId,
        depth,
        spawn_turn_seq: share.spawn_anchor_turn_seq ?? null,
        source: share.session.source,
        ...(share.session.model ? { model: share.session.model } : {}),
        ...(share.session.started_at ? { started_at: share.session.started_at } : {}),
        ...(share.session.ended_at ? { ended_at: share.session.ended_at } : {}),
        duration_ms: durationMs(share.session.started_at, share.session.ended_at),
        stats: share.stats,
        cost_usd: share.token_usage?.estimated_cost_usd ?? null,
        estimated_tokens: share.token_usage?.estimated_tokens ?? null,
        ...(taskLabel ? { task_label: taskLabel } : {}),
        had_error: share.stats.failures > 0,
    };
};

const sum = (values: ReadonlyArray<number>): number => values.reduce((a, b) => a + b, 0);

/**
 * Flatten a recursive share (root + nested `children`) into a publishable
 * multi-file bundle: a manifest with per-descendant cards + whole-trace
 * totals, the root file, and one file per descendant.
 */
export function buildShareBundle(root: AxSessionShare, narration?: ShareNarrationArtifact): ShareBundle {
    const cards: ShareSubagentCard[] = [];
    const descendantFiles: ShareBundleFile[] = [];

    const walk = (node: AxSessionShare, parentId: string | null, depth: number): void => {
        for (const child of node.children ?? []) {
            cards.push(cardFor(child, parentId, depth));
            descendantFiles.push({ name: subagentFileName(child.session.id), content: withoutChildren(child) });
            walk(child, child.session.id, depth + 1);
        }
    };
    walk(root, root.session.id, 1);

    const allCosts = [root.token_usage?.estimated_cost_usd ?? null, ...cards.map((c) => c.cost_usd)]
        .filter((v): v is number => v !== null);
    const rootDuration = durationMs(root.session.started_at, root.session.ended_at);
    const childDurations = cards.map((c) => c.duration_ms).filter((v): v is number => v !== null);

    const manifest: AxSessionShareManifest = {
        schema_version: narration ? AX_SESSION_SHARE_MANIFEST_SCHEMA_VERSION : AX_SESSION_SHARE_SCHEMA_VERSION,
        kind: "manifest",
        exported_at: root.exported_at,
        ax_version: root.ax_version,
        session: root.session,
        stats: root.stats,
        token_usage: root.token_usage ?? null,
        root_file: SHARE_ROOT_FILE,
        totals: {
            cost_usd: allCosts.length > 0 ? sum(allCosts) : null,
            duration_ms: rootDuration === null && childDurations.length === 0
                ? null
                : (rootDuration ?? 0) + sum(childDurations),
            tool_calls: root.stats.tool_calls + sum(cards.map((c) => c.stats.tool_calls)),
            turns: root.stats.turns + sum(cards.map((c) => c.stats.turns)),
            subagents: cards.length,
            failures: root.stats.failures + sum(cards.map((c) => c.stats.failures)),
        },
        subagents: cards,
        redactions: root.redactions,
        ...(narration ? { narration_file: SHARE_NARRATION_FILE } : {}),
    };

    return {
        manifest,
        files: [
            { name: SHARE_MANIFEST_FILE, content: manifest },
            { name: SHARE_ROOT_FILE, content: withoutChildren(root) },
            ...descendantFiles,
            ...(narration ? [{ name: SHARE_NARRATION_FILE, content: narration }] : []),
        ],
    };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

export function isAxSessionShareManifest(value: unknown): value is AxSessionShareManifest {
    return (
        isRecord(value) &&
        value.kind === "manifest" &&
        typeof value.schema_version === "number" &&
        (SUPPORTED_SHARE_MANIFEST_SCHEMA_VERSIONS as readonly number[]).includes(value.schema_version) &&
        isRecord(value.session) &&
        typeof value.session.id === "string" &&
        isRecord(value.totals) &&
        Array.isArray(value.subagents) &&
        typeof value.root_file === "string" &&
        (value.narration_file === undefined || value.narration_file === SHARE_NARRATION_FILE)
    );
}
