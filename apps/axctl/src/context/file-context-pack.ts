import { Effect } from "effect";
import type { DbError } from "@ax/lib/errors";
import { SurrealClient } from "@ax/lib/db";
import {
    type BuildFileContextInput,
    type FileRow,
    loadNeighborFiles,
    loadProducedSessionTurns,
    loadPriorFileSessions,
    loadToolEvidenceTable,
    loadTouches,
    loadMentions,
    type MentionSignals,
    type MentionTurn,
    type NeighborFile,
    type PriorFileSession,
    resolveFiles,
    type SessionTurn,
    type ToolEvidenceRow,
    type TouchRow,
} from "./file-evidence.ts";
import {
    clip,
    compactToolEvidence,
    compactTouchesForContext,
    extractFileContextSignals,
    queryTokens,
    rankSessionTurns,
} from "./file-evidence-rank.ts";

// ============================================================================
// File Context Pack - the broad, CLI-facing File Evidence adapter
// (`ax context file`). Composes every evidence kind, ranks/compacts for
// display, and renders the `ai_context` block + graph-inspection query.
// ============================================================================

export type { BuildFileContextInput } from "./file-evidence.ts";

export interface FileContextPack {
    readonly kind: "ax.file_context_pack";
    readonly task: string;
    readonly generated_at: string;
    readonly signals: MentionSignals;
    readonly files: readonly FileRow[];
    readonly ai_context: string;
    readonly graph_inspection_query: string;
    readonly evidence: {
        readonly tool_file: readonly ToolEvidenceRow[];
        readonly touches: readonly TouchRow[];
        readonly produced_session_turns: readonly SessionTurn[];
        readonly prior_file_sessions: readonly PriorFileSession[];
        readonly mention_turns: readonly MentionTurn[];
        readonly neighbor_files: readonly NeighborFile[];
    };
}

function renderInspectionQuery(files: readonly FileRow[]): string {
    if (files.length === 0) return "-- No matched file records to inspect.";
    const fileRefs = files.map((file) => file.id).join(", ");
    return [
        `LET $files = [${fileRefs}];`,
        "SELECT id, path, repo, repository FROM file WHERE id IN $files;",
        "SELECT id, evidence, path_seen, ts, out.{ id, path } AS file, in.{ id, name, command_norm, turn, session } AS tool_call FROM read_file WHERE out IN $files ORDER BY ts DESC LIMIT 40;",
        "SELECT id, evidence, path_seen, ts, out.{ id, path } AS file, in.{ id, name, command_norm, turn, session } AS tool_call FROM searched_file WHERE out IN $files ORDER BY ts DESC LIMIT 40;",
        "SELECT id, source, confidence, ts, out.{ id, path } AS file, in.{ id, session, seq, intent_kind, text_excerpt } AS turn FROM mentioned_file WHERE out IN $files ORDER BY ts DESC LIMIT 40;",
        "SELECT in.session AS session, out.path AS file, count() AS edit_count, time::max(ts) AS last_seen FROM edited WHERE out IN $files GROUP BY session, file ORDER BY edit_count DESC, last_seen DESC LIMIT 40;",
        "SELECT id, additions, deletions, ts, out.{ id, path } AS file, in.{ sha, message, author, ts, sessions: <-produced.in.{ id, source, cwd } } AS commit FROM touched WHERE out IN $files ORDER BY ts DESC LIMIT 40;",
    ].join("\n\n");
}

function renderAiContext(
    input: BuildFileContextInput,
    signals: MentionSignals,
    files: readonly FileRow[],
    toolEvidence: readonly ToolEvidenceRow[],
    touches: readonly TouchRow[],
    producedSessionTurns: readonly SessionTurn[],
    priorFileSessions: readonly PriorFileSession[],
    mentions: readonly MentionTurn[],
    neighbors: readonly NeighborFile[],
): string {
    const tokens = queryTokens(input.q);
    const rankedProducedTurns = rankSessionTurns(producedSessionTurns, tokens);
    const compactTouches = compactTouchesForContext(touches);
    const lines = [
        "<ax_file_context>",
        `Current bug/task: ${input.q}`,
        "",
        "Relevant files:",
        ...(files.length === 0 ? ["- No matching file nodes found."] : files.map((file) => `- ${file.path}`)),
    ];

    if (signals.errors.length > 0 || signals.symbols.length > 0) {
        lines.push("", "Extracted bug signals:");
        for (const error of signals.errors) lines.push(`- error: ${error}`);
        for (const symbol of signals.symbols.slice(0, 8)) lines.push(`- symbol: ${symbol}`);
    }

    if (toolEvidence.length > 0) {
        lines.push("", "Observed tool evidence for these files:");
        for (const evidence of toolEvidence.slice(0, 6)) {
            const tool = [evidence.tool_name, evidence.command_norm].filter(Boolean).join("/") || "?";
            lines.push(`- ${evidence.kind}: ${evidence.path ?? evidence.path_seen ?? "?"} via ${tool}`);
            lines.push(`  Source: ${evidence.turn?.session?.source ?? "?"} ${evidence.turn?.session?.id ?? "?"} seq ${evidence.turn?.seq ?? "?"}; ${evidence.evidence ?? "observed"}`);
        }
    }

    if (mentions.length > 0) {
        lines.push("", "Prior user context mentioning the same files/errors/symbols:");
        for (const turn of mentions.slice(0, 6)) {
            lines.push(`- ${clip((turn.text_excerpt ?? "").replace(/\s+/g, " "), 240)}`);
            lines.push(`  Source: ${turn.session} seq ${turn.seq ?? "?"}; intent=${turn.intent_kind ?? "?"}; ${turn.why.join(", ")}`);
        }
    }

    if (rankedProducedTurns.length > 0) {
        lines.push("", "Prior user context from sessions that produced commits touching these files:");
        for (const turn of rankedProducedTurns.slice(0, 6)) {
            lines.push(`- ${clip((turn.text_excerpt ?? "").replace(/\s+/g, " "), 240)}`);
            lines.push(`  Source: ${turn.session} seq ${turn.seq ?? "?"}; intent=${turn.intent_kind ?? "?"}`);
        }
    }

    if (priorFileSessions.length > 0) {
        lines.push("", "Prior sessions that edited these files:");
        for (const session of priorFileSessions.slice(0, 6)) {
            const parts = [
                `${session.weight} edits`,
                `${session.files_touched} files`,
                `${session.produced_commits} commits`,
                `${session.user_turns}u/${session.assistant_turns}a`,
                session.corrections > 0 ? `${session.corrections} corrections` : null,
                session.interruptions > 0 ? `${session.interruptions} interruptions` : null,
                session.merged_to_main ? "main" : null,
                session.delivery_status,
                session.review_pain ? `${session.review_pain} review` : null,
            ].filter(Boolean);
            lines.push(`- ${clip((session.title ?? session.project ?? session.session).replace(/\s+/g, " "), 240)}`);
            lines.push(`  Source: ${session.session}; ${parts.join(", ")}`);
            if (session.top_files.length > 0) lines.push(`  Files: ${session.top_files.slice(0, 3).join(", ")}`);
        }
    }

    if (compactTouches.length > 0) {
        lines.push("", "Recent commits touching these files:");
        for (const touch of compactTouches.slice(0, 5)) {
            lines.push(`- ${touch.commit?.sha?.slice(0, 10) ?? "?"}: ${clip(touch.commit?.message ?? "(no message)", 180)}`);
        }
    }

    if (neighbors.length > 0) {
        lines.push("", "Neighbor files often changed with these files:");
        for (const neighbor of neighbors.slice(0, 8)) lines.push(`- ${neighbor.path} (${neighbor.count})`);
    }

    lines.push("</ax_file_context>");
    return lines.join("\n");
}

export const buildFileContextPack = (input: BuildFileContextInput): Effect.Effect<FileContextPack, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const signals = extractFileContextSignals(input.q, input.files);
        const files = yield* resolveFiles(signals.paths, { fuzzyFallback: true });
        const fileIds = files.map((file) => file.id);
        const [reads, searches, touches, mentions] = yield* Effect.all([
            loadToolEvidenceTable("read_file", fileIds),
            loadToolEvidenceTable("searched_file", fileIds),
            loadTouches(fileIds),
            loadMentions(signals, files),
        ]);
        const toolEvidence = compactToolEvidence([...reads, ...searches]).slice(0, 12);
        const [producedSessionTurns, priorFileSessions, neighbors] = yield* Effect.all([
            loadProducedSessionTurns(touches),
            loadPriorFileSessions(fileIds, 40),
            loadNeighborFiles(touches, files.map((file) => file.path)),
        ]);
        return {
            kind: "ax.file_context_pack",
            task: input.q,
            generated_at: new Date().toISOString(),
            signals,
            files,
            ai_context: renderAiContext(input, signals, files, toolEvidence, touches, producedSessionTurns, priorFileSessions, mentions, neighbors),
            graph_inspection_query: renderInspectionQuery(files),
            evidence: {
                tool_file: toolEvidence,
                touches,
                produced_session_turns: producedSessionTurns,
                prior_file_sessions: priorFileSessions,
                mention_turns: mentions,
                neighbor_files: neighbors,
            },
        };
    });
