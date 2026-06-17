// ============================================================================
// File Evidence - shared row/result types.
//
// The bottom layer of the File Evidence trio: the retrieval primitives
// (file-evidence.ts), the pure rank/signal helpers (file-evidence-rank.ts), and
// both adapters all import these down. No runtime code lives here.
// ============================================================================

export interface FileRow {
    readonly id: string;
    readonly path: string;
    readonly repo?: string | null;
    readonly repository?: string | null;
}

export interface ToolEvidenceRow {
    readonly kind: "read_file" | "searched_file";
    readonly evidence?: string | null;
    readonly path_seen?: string | null;
    readonly excerpt?: string | null;
    readonly ts?: string | null;
    readonly path?: string | null;
    readonly tool_name?: string | null;
    readonly command_norm?: string | null;
    readonly turn?: {
        readonly id?: string;
        readonly session?: {
            readonly id?: string;
            readonly source?: string | null;
        } | null;
        readonly seq?: number | null;
        readonly intent_kind?: string | null;
        readonly text_excerpt?: string | null;
    } | null;
}

export interface TouchRow {
    readonly id: string;
    readonly additions?: number | null;
    readonly deletions?: number | null;
    readonly ts?: string | null;
    readonly file?: FileRow | null;
    readonly commit?: {
        readonly id?: string | null;
        readonly sha?: string | null;
        readonly message?: string | null;
        readonly author?: string | null;
        readonly ts?: string | null;
        readonly sessions?: readonly {
            readonly id?: string;
            readonly source?: string | null;
            readonly cwd?: string | null;
        }[];
    } | null;
}

export interface MentionTurn {
    readonly id: string;
    readonly session: string;
    readonly source?: string | null;
    readonly seq?: number | null;
    readonly ts?: string | null;
    readonly intent_kind?: string | null;
    readonly text_excerpt?: string | null;
    readonly score: number;
    readonly why: readonly string[];
}

export interface SessionTurn {
    readonly id: string;
    readonly session: string;
    readonly source?: string | null;
    readonly seq?: number | null;
    readonly ts?: string | null;
    readonly message_kind?: string | null;
    readonly intent_kind?: string | null;
    readonly text_excerpt?: string | null;
}

export interface NeighborFile {
    readonly path: string;
    readonly count: number;
}

export interface PriorFileSession {
    readonly session: string;
    readonly title: string | null;
    readonly project: string | null;
    readonly source: string | null;
    readonly weight: number;
    readonly files_touched: number;
    readonly top_files: readonly string[];
    readonly produced_commits: number;
    readonly delivery_status: string | null;
    readonly review_pain: string | null;
    readonly pr_size: string | null;
    readonly pr_title: string | null;
    readonly merged_to_main: boolean;
    readonly user_turns: number;
    readonly assistant_turns: number;
    readonly corrections: number;
    readonly interruptions: number;
    readonly duration_ms: number | null;
    readonly hands_free_ms: number | null;
    readonly last_seen: string | null;
}

export interface MentionSignals {
    readonly paths: readonly string[];
    readonly symbols: readonly string[];
    readonly errors: readonly string[];
}

/** The shared input for both File Evidence adapters: a task string plus the
 *  file paths an agent named or touched. */
export interface BuildFileContextInput {
    readonly q: string;
    readonly files: readonly string[];
}

export interface FileMemoryCorrection {
    readonly turn_id: string;
    readonly session_id: string;
    readonly ts: string | null;
    readonly text: string;
    readonly delivery_status: string | null;
    readonly pr_title: string | null;
}

export interface FileMemoryCommit {
    readonly commit_id: string;
    readonly sha: string | null;
    readonly message: string | null;
    readonly ts: string | null;
}

export interface FileMemoryCoTouch {
    readonly path: string;
    readonly co_sessions: number;
    readonly total_sessions: number;
}
