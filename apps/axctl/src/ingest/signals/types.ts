import type { TimestampInput } from "@ax/lib/shared/derive-keys";

export type RecordRefLike = string | { tb?: string; id?: unknown };
export type JsonRecord = Record<string, unknown>;

export interface ToolCallLike {
    readonly id?: RecordRefLike;
    readonly session?: RecordRefLike;
    readonly turn?: RecordRefLike;
    readonly tool?: RecordRefLike | { name?: unknown };
    readonly tool_name?: string;
    readonly toolName?: string;
    readonly name?: string;
    readonly command_norm?: string;
    readonly commandNorm?: string;
    readonly output_excerpt?: string;
    readonly outputExcerpt?: string;
    readonly error_text?: string;
    readonly errorText?: string;
    readonly exit_code?: number;
    readonly exitCode?: number;
    readonly duration_ms?: number;
    readonly durationMs?: number;
    readonly status?: string;
    readonly has_error?: boolean;
    readonly hasError?: boolean;
    readonly ts?: TimestampInput;
    readonly cwd?: string;
    readonly seq?: number;
    readonly call_id?: string;
    readonly callId?: string;
    readonly repository?: RecordRefLike;
    readonly checkout?: RecordRefLike;
}

export interface DerivedFrictionEvent {
    readonly key: string;
    readonly kind: string;
    readonly sessionId: string | null;
    readonly turnKey: string | null;
    readonly targetType?: string;
    readonly targetName?: string;
    readonly source?: string;
    readonly confidence?: number;
    readonly text: string | null;
    readonly labels: JsonRecord;
    readonly metrics: JsonRecord;
    readonly raw: JsonRecord;
    readonly ts: string;
}

export interface DerivedDiagnosticEvent {
    readonly key: string;
    readonly kind: string;
    readonly status: string | null;
    readonly sessionId: string | null;
    readonly turnKey: string | null;
    readonly targetType?: string;
    readonly targetName?: string;
    readonly source?: string;
    readonly confidence?: number;
    readonly text: string | null;
    readonly labels: JsonRecord;
    readonly metrics: JsonRecord;
    readonly raw: JsonRecord;
    readonly ts: string;
}

export interface TurnRow {
    id: { tb: string; id: string } | string;
    seq: number;
    role: string;
    text_excerpt: string | undefined;
    ts: string | Date;
    has_error: boolean;
    invoked_skills: ReadonlyArray<string>; // skill names this turn already invoked
    repository?: RecordRefLike;
    checkout?: RecordRefLike;
    cwd?: string;
}

export interface SessionTurns {
    sessionId: string;
    repositoryKey: string | null;
    checkoutKey: string | null;
    cwd: string | null;
    turns: TurnRow[];
}

export interface CorrectionEdge {
    fromTurnKey: string;
    toTurnKey: string;
    pattern: string;
    text: string;
    ts: string;
    repositoryKey: string | null;
    checkoutKey: string | null;
    cwd: string | null;
    // Session + seq of the corrected (assistant) turn. Used to mark
    // invoked edges as `was_corrected = true` for any invocation whose
    // turn falls in [correctedSeq - 3, correctedSeq] (matches the
    // pre-denormalisation cmdTaste +3 seq window). See issue #31.
    correctedSession: string;
    correctedSeq: number;
}

export interface ProposedEdge {
    fromTurnKey: string;
    skillKey: string;
    skillName: string;
    ts: string;
    contextExcerpt: string;
}

export interface SkillPairAccum {
    fromKey: string;
    toKey: string;
    count: number;
    lastSeen: string; // ISO
}

export interface RecoveryEdge {
    fromTurnKey: string;
    skillKey: string;
    skillName: string;
    ts: string;
    errorExcerpt: string | undefined;
}

/** Everything the derivation core needs to run - the typed mirror of the
 *  three SELECTs in derive-signals.ts. */
export interface SignalEvidence {
    readonly bundles: ReadonlyArray<SessionTurns>;
    readonly skillNames: ReadonlyArray<string>;
    readonly failedToolCalls: ReadonlyArray<ToolCallLike>;
}

/** Everything the core derives - the typed input of signals/statements.ts. */
export interface DerivedSignals {
    readonly corrections: CorrectionEdge[];
    readonly proposed: ProposedEdge[];
    readonly recoveries: RecoveryEdge[];
    /** Accumulated skill pairs, each carrying its deterministic
     *  `skill_paired` edge record-id (the accumulator map key). */
    readonly skillPairs: ReadonlyArray<{
        readonly edgeId: string;
        readonly pair: SkillPairAccum;
    }>;
    readonly frictionEvents: DerivedFrictionEvent[];
    readonly diagnosticEvents: DerivedDiagnosticEvent[];
    readonly turnCount: number;
}
