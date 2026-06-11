/**
 * Session narration artifact - the agent-generated story of what changed in
 * one recorded session, INCLUDING the parts that never reach a PR: user
 * directions and corrections, abandoned attempts, tool failures.
 *
 * The shape extends plannotator's CodeTourOutput (title/intent/before/after +
 * ordered stops with gist/detail/anchors) with provenance anchors that point
 * back into the session graph (turn seqs) instead of only diff hunks.
 *
 * Produced by the `ax-narrate` skill at session end as
 * `.ax/narrations/<session-id>.json`; rendered by `NarrationPanel` in studio.
 * Validation is a plain TS type guard (`isSessionNarration`) in the style of
 * `isShareManifest` - no schema libs, JSON in, narrowed type out.
 */

export const NARRATION_SCHEMA_VERSION = 1 as const;

export type NarrationGenerator = "skill" | "hook";

/** Session metadata header - who narrated what, when, with which model. */
export interface NarrationMeta {
    /** ax session id (the harness session uuid, or its short prefix). */
    readonly session_id: string;
    /** ISO-8601 timestamp of generation. */
    readonly generated_at: string;
    /** What produced this narration - the skill fired by the user, or a stop-time hook. */
    readonly generator: NarrationGenerator;
    /** Model that wrote the narration, e.g. "claude-fable-5". */
    readonly model: string;
}

// ---------------------------------------------------------------------------
// Anchors - the provenance a stop points at. A stop's anchors may span
// multiple files AND multiple kinds: a hunk, the correction that caused it,
// and the failure on the way there all hang off the same stop.
// ---------------------------------------------------------------------------

/** A real code change: verbatim old/new fragments straight from the tool
 *  calls (the same shape `buildHunkPatch` synthesizes a unified diff from).
 *  One side may be null: pure insertion (new file / Write) or pure deletion. */
export interface FileHunkAnchor {
    readonly kind: "file_hunk";
    /** Path as it appeared in the session (repo-relative preferred). */
    readonly file: string;
    /** Verbatim replaced fragment - null for pure insertions. */
    readonly old_text: string | null;
    /** Verbatim inserted fragment - null for pure deletions. */
    readonly new_text: string | null;
    /** One-sentence label: what this change does or why it matters. */
    readonly label: string;
    /** Turn where the edit landed, when known - the jump target. */
    readonly turn_seq?: number;
}

/** A plain pointer at a moment in the transcript. */
export interface TurnAnchor {
    readonly kind: "turn";
    readonly turn_seq: number;
    /** What happened at this turn, one sentence. */
    readonly label: string;
}

/** The user steering the work - an instruction that shaped what came next. */
export interface UserDirectionAnchor {
    readonly kind: "user_direction";
    readonly turn_seq: number;
    /** Verbatim (possibly trimmed) quote of the user's words. */
    readonly quote: string;
}

/** The user correcting course - the part a PR never shows. */
export interface CorrectionAnchor {
    readonly kind: "correction";
    readonly turn_seq: number;
    /** Verbatim (possibly trimmed) quote of the correction. */
    readonly quote: string;
    /** What changed as a result - the concrete pivot the correction caused. */
    readonly outcome: string;
}

/** A consequential tool failure and how the agent recovered. */
export interface ToolFailureAnchor {
    readonly kind: "tool_failure";
    readonly turn_seq: number;
    /** Tool that failed, e.g. "Bash", "Edit". */
    readonly tool: string;
    /** Short verbatim excerpt of the error output. */
    readonly error_excerpt: string;
    /** How the agent got past it (or "abandoned" if it never did). */
    readonly recovery: string;
}

/** A domain term the narration leans on - rendered as an inline chip. */
export interface TermAnchor {
    readonly kind: "term";
    readonly name: string;
    /** Definition, or a pointer to where the term is defined. */
    readonly definition: string;
}

/**
 * A snapshot of a named evolving artifact - architecture pseudo-code, a call
 * graph, a type shape - as it stands AT this stop. Consecutive stops carrying
 * the same `artifact` id animate between snapshots (token morph), which is
 * the register where motion actually explains: a method appears, a shape
 * renames, an edge case slots in. Unrelated code jumps should be file_hunk
 * anchors instead - those render as static before/after diffs.
 */
export interface CodeStateAnchor {
    readonly kind: "code_state";
    /** Stable id of the evolving thing, e.g. "review-architecture". Morphing
     *  happens only between snapshots sharing this id. */
    readonly artifact: string;
    /** One-line label for this snapshot's state. */
    readonly label: string;
    /** Canonical grammar id ("typescript", "text", ...). */
    readonly lang: string;
    /** The full snapshot - not a fragment; each stop restates the artifact. */
    readonly code: string;
    readonly turn_seq?: number;
}

export type NarrationAnchor =
    | FileHunkAnchor
    | TurnAnchor
    | UserDirectionAnchor
    | CorrectionAnchor
    | ToolFailureAnchor
    | TermAnchor
    | CodeStateAnchor;

export type NarrationAnchorKind = NarrationAnchor["kind"];

// ---------------------------------------------------------------------------
// Stops + document
// ---------------------------------------------------------------------------

/** One stop in the story - a logical unit of change, not a file. */
export interface NarrationStop {
    /** Short, friendly chapter title. */
    readonly title: string;
    /** ONE sentence - the headline, scannable without expanding. */
    readonly gist: string;
    /** 2-4 sentences of markdown (paragraphs + `inline code`). */
    readonly detail: string;
    /** Connective phrase to the next stop; "" for the last stop. */
    readonly transition: string;
    /** Provenance - MUST be non-empty; may span files and kinds. */
    readonly anchors: ReadonlyArray<NarrationAnchor>;
}

export interface SessionNarration {
    readonly schema_version: typeof NARRATION_SCHEMA_VERSION;
    readonly kind: "narration";
    readonly meta: NarrationMeta;
    /** One-line title for the whole session story. */
    readonly title: string;
    /** 1-3 sentences: why this session happened. */
    readonly intent: string;
    /** The world before the session, one sentence. */
    readonly before: string;
    /** The world after, one sentence. */
    readonly after: string;
    /** 3-7 stops in reading-flow order - MUST be non-empty. */
    readonly stops: ReadonlyArray<NarrationStop>;
}

// ---------------------------------------------------------------------------
// Validation - plain type guards, no deps (isShareManifest style)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isOptionalSeq(value: unknown): boolean {
    return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

export function isNarrationAnchor(value: unknown): value is NarrationAnchor {
    if (!isRecord(value)) return false;
    switch (value.kind) {
        case "file_hunk": {
            const oldOk = value.old_text === null || typeof value.old_text === "string";
            const newOk = value.new_text === null || typeof value.new_text === "string";
            // A hunk with neither side is empty provenance - reject it.
            const hasSide = isNonEmptyString(value.old_text) || isNonEmptyString(value.new_text);
            return (
                isNonEmptyString(value.file) &&
                oldOk && newOk && hasSide &&
                isNonEmptyString(value.label) &&
                isOptionalSeq(value.turn_seq)
            );
        }
        case "turn":
            return typeof value.turn_seq === "number" && isNonEmptyString(value.label);
        case "user_direction":
            return typeof value.turn_seq === "number" && isNonEmptyString(value.quote);
        case "correction":
            return (
                typeof value.turn_seq === "number" &&
                isNonEmptyString(value.quote) &&
                isNonEmptyString(value.outcome)
            );
        case "tool_failure":
            return (
                typeof value.turn_seq === "number" &&
                isNonEmptyString(value.tool) &&
                isNonEmptyString(value.error_excerpt) &&
                isNonEmptyString(value.recovery)
            );
        case "term":
            return isNonEmptyString(value.name) && isNonEmptyString(value.definition);
        case "code_state":
            return (
                isNonEmptyString(value.artifact) &&
                isNonEmptyString(value.label) &&
                isNonEmptyString(value.lang) &&
                isNonEmptyString(value.code) &&
                isOptionalSeq(value.turn_seq)
            );
        default:
            return false;
    }
}

export function isNarrationStop(value: unknown): value is NarrationStop {
    return (
        isRecord(value) &&
        isNonEmptyString(value.title) &&
        isNonEmptyString(value.gist) &&
        isNonEmptyString(value.detail) &&
        typeof value.transition === "string" &&
        Array.isArray(value.anchors) &&
        value.anchors.length > 0 &&
        value.anchors.every(isNarrationAnchor)
    );
}

function isNarrationMeta(value: unknown): value is NarrationMeta {
    return (
        isRecord(value) &&
        isNonEmptyString(value.session_id) &&
        isNonEmptyString(value.generated_at) &&
        (value.generator === "skill" || value.generator === "hook") &&
        isNonEmptyString(value.model)
    );
}

/** Top-level guard: parse JSON, pass it here, get a typed narration back. */
export function isSessionNarration(value: unknown): value is SessionNarration {
    return (
        isRecord(value) &&
        value.schema_version === NARRATION_SCHEMA_VERSION &&
        value.kind === "narration" &&
        isNarrationMeta(value.meta) &&
        isNonEmptyString(value.title) &&
        typeof value.intent === "string" &&
        typeof value.before === "string" &&
        typeof value.after === "string" &&
        Array.isArray(value.stops) &&
        value.stops.length > 0 &&
        value.stops.every(isNarrationStop)
    );
}
