import type { HookFireDto, InspectTurnContentDto, SessionTokenUsageDetail, ToolCallDto, TurnTokenUsageDetail } from "@ax/lib/shared/dashboard-types";

export const AX_SESSION_SHARE_SCHEMA_VERSION = 4 as const;

/**
 * Schema versions a reader still accepts.
 * - v1: flat single file, no children.
 * - v2: single file, `children` nested inline.
 * - v3: multi-file gist bundle - an `index.json` manifest + one
 *   `session.json` (root) + `subagent-<id>.json` per descendant; per-file
 *   shares no longer inline `children` (they are referenced from the manifest).
 * - v4: per-turn structured `tool_calls` (typed args) replace the baked
 *   `🔧 …` synthesized text. v1–v3 readers fall back to the text path.
 */
export const SUPPORTED_SHARE_SCHEMA_VERSIONS = [1, 2, 3, 4] as const;
export type ShareSchemaVersion = (typeof SUPPORTED_SHARE_SCHEMA_VERSIONS)[number];

export type KnownShareSource = "claude" | "codex" | "pi" | "opencode" | "cursor";
export type ShareSource = KnownShareSource | (string & {});

export interface AxSessionShare {
    readonly schema_version: ShareSchemaVersion;
    readonly exported_at: string;
    readonly ax_version: string;
    readonly session: {
        readonly id: string;
        readonly source: ShareSource;
        readonly model?: string;
        readonly project?: string;
        readonly repository?: string;
        readonly started_at?: string;
        readonly ended_at?: string;
        readonly summary?: string;
    };
    readonly stats: {
        readonly turns: number;
        readonly tool_calls: number;
        readonly files_changed: number;
        readonly skills_used: number;
        readonly failures: number;
    };
    readonly token_usage?: SessionTokenUsageDetail | null;
    /** v3+: runtime hook-fire decisions (file-context injections etc.), so the
     *  shared inspector can show + jump to them like the live one. */
    readonly hook_fires?: ReadonlyArray<HookFireDto>;
    /** v3+: harness hook invocations that DID something (blocked / modified /
     *  injected), anchored to the nearest turn, so the shared transcript shows
     *  where guardrail hooks fired. */
    readonly harness_hooks?: ReadonlyArray<ShareHarnessHook>;
    readonly turns: ReadonlyArray<ShareTurn>;
    readonly timeline: ReadonlyArray<ShareEvent>;
    readonly files: ReadonlyArray<ShareFile>;
    readonly graph: ShareGraph;
    readonly derived: {
        readonly working_style?: ReadonlyArray<string>;
        readonly decisions?: ReadonlyArray<string>;
        readonly call_graphs?: ReadonlyArray<{ readonly label: string; readonly body: string }>;
        readonly outcome?: string;
    };
    readonly redactions: {
        readonly applied: boolean;
        readonly rules: ReadonlyArray<string>;
    };
    /**
     * v2+: child subagent sessions spawned by this session, each a full
     * (recursively redacted) share artifact. Absent/empty when the session
     * delegated no subagents. Recursion terminates at leaf sessions.
     */
    readonly children?: ReadonlyArray<AxSessionShare>;
    /**
     * v3+: the seq of the turn IN THIS SESSION'S PARENT where this session was
     * spawned (matched from the spawn-edge timestamp). Lets the viewer anchor a
     * "spawned subagent" marker at the right point in the parent transcript.
     * Absent on the root and when no parent turn matched.
     */
    readonly spawn_anchor_turn_seq?: number | null;
}

/** A harness hook invocation surfaced in a shared transcript. */
export interface ShareHarnessHook {
    /** Monotonic index for stable DOM ids / jump cursor. */
    readonly idx: number;
    readonly ts: string;
    /** PreToolUse | PostToolUse | SessionStart | UserPromptSubmit | Stop | ... */
    readonly event_name: string;
    /** e.g. PreToolUse:Write, SessionStart:startup */
    readonly hook_name: string;
    /** allowed | blocked | injected_context | modified_input | notified | no_op */
    readonly effect: string;
    /** progress_only | success | blocking_error */
    readonly status: string;
    /** The command the hook ran (e.g. `axctl hook file-context`). */
    readonly command?: string;
    /** What the hook did/injected: the injected context, blocking reason, or
     *  output excerpt - so the reader can show *why* it fired, not just that. */
    readonly detail?: string;
    /** Nearest turn seq by timestamp, for inline placement. */
    readonly anchor_turn_seq: number | null;
}

export interface ShareTurn {
    readonly id: string;
    readonly seq: number;
    readonly ts?: string;
    readonly role: string;
    readonly message_kind?: string;
    readonly intent_kind?: string;
    readonly text: string;
    readonly text_excerpt?: string;
    readonly has_tool_use?: boolean;
    readonly has_error?: boolean;
    readonly token_usage?: TurnTokenUsageDetail | null;
    readonly content?: InspectTurnContentDto | null;
    /** v4+: structured tool invocations on this turn (typed args). */
    readonly tool_calls?: ReadonlyArray<ToolCallDto>;
}

export interface ShareEvent {
    readonly id: string;
    readonly ts?: string;
    readonly kind:
        | "message"
        | "tool_call"
        | "file_edit"
        | "skill_invocation"
        | "decision"
        | "checkpoint"
        | "failure"
        | "outcome";
    readonly actor?: string;
    readonly title: string;
    readonly summary?: string;
    readonly refs?: ReadonlyArray<{ readonly type: "file" | "tool" | "skill" | "turn"; readonly id: string }>;
}

export interface ShareFile {
    readonly path: string;
    readonly lang?: string;
    readonly role?: "read" | "edited" | "touched";
    readonly additions?: number;
    readonly deletions?: number;
}

export interface ShareGraph {
    readonly nodes: ReadonlyArray<{
        readonly id: string;
        readonly kind: "session" | "actor" | "tool" | "skill" | "file" | "decision" | "artifact";
        readonly label: string;
    }>;
    readonly edges: ReadonlyArray<{
        readonly from: string;
        readonly to: string;
        readonly label: string;
    }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const hasNumericStats = (value: Record<string, unknown>): boolean =>
    typeof value.turns === "number" &&
    typeof value.tool_calls === "number" &&
    typeof value.files_changed === "number" &&
    typeof value.skills_used === "number" &&
    typeof value.failures === "number";

export function isAxSessionShare(value: unknown): value is AxSessionShare {
    if (!isRecord(value)) return false;
    if (
        typeof value.schema_version !== "number" ||
        !(SUPPORTED_SHARE_SCHEMA_VERSIONS as ReadonlyArray<number>).includes(value.schema_version)
    ) {
        return false;
    }
    if (typeof value.exported_at !== "string") return false;
    if (typeof value.ax_version !== "string") return false;
    if (!isRecord(value.session)) return false;
    if (typeof value.session.id !== "string") return false;
    if (typeof value.session.source !== "string") return false;
    if (!isRecord(value.stats)) return false;
    if (!hasNumericStats(value.stats)) return false;
    if (!Array.isArray(value.timeline)) return false;
    if (!Array.isArray(value.files)) return false;
    if (!isRecord(value.graph)) return false;
    if (!Array.isArray(value.graph.nodes)) return false;
    if (!Array.isArray(value.graph.edges)) return false;
    if (!isRecord(value.derived)) return false;
    if (!isRecord(value.redactions)) return false;
    if (typeof value.redactions.applied !== "boolean") return false;
    if (!Array.isArray(value.redactions.rules)) return false;
    if (value.children !== undefined) {
        if (!Array.isArray(value.children)) return false;
        if (!value.children.every((child) => isAxSessionShare(child))) return false;
    }
    return true;
}

export function minimalShareArtifact(input: {
    readonly id: string;
    readonly source: ShareSource;
    readonly exported_at?: string;
    readonly ax_version?: string;
}): AxSessionShare {
    return {
        schema_version: AX_SESSION_SHARE_SCHEMA_VERSION,
        exported_at: input.exported_at ?? "2026-05-29T00:00:00.000Z",
        ax_version: input.ax_version ?? "0.0.0-test",
        session: {
            id: input.id,
            source: input.source,
        },
        stats: {
            turns: 0,
            tool_calls: 0,
            files_changed: 0,
            skills_used: 0,
            failures: 0,
        },
        turns: [],
        timeline: [],
        files: [],
        graph: {
            nodes: [],
            edges: [],
        },
        derived: {},
        redactions: {
            applied: false,
            rules: [],
        },
    };
}
