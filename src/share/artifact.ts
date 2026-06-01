import type { InspectTurnContentDto, SessionTokenUsageDetail, TurnTokenUsageDetail } from "@ax/lib/shared/dashboard-types";

export const AX_SESSION_SHARE_SCHEMA_VERSION = 1 as const;

export type KnownShareSource = "claude" | "codex" | "pi" | "opencode" | "cursor";
export type ShareSource = KnownShareSource | (string & {});

export interface AxSessionShare {
    readonly schema_version: typeof AX_SESSION_SHARE_SCHEMA_VERSION;
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
    if (value.schema_version !== AX_SESSION_SHARE_SCHEMA_VERSION) return false;
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
