import { Effect } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
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

/**
 * DuckDB SQL a human can paste into `ax duckdb sql` (or any DuckDB client
 * against the published snapshot) to dig deeper than the rendered context.
 * Written against the same tables/joins `context/file-evidence.ts` itself
 * queries. `commit.sessions` (the reverse session-produced-commit traversal)
 * has no single-statement DuckDB equivalent; add a `JOIN produced p ON
 * p.out_id = c.id JOIN session s ON s.id = p.in_id` to the last query for
 * that.
 */
function renderInspectionQuery(files: readonly FileRow[]): string {
    if (files.length === 0) return "-- No matched file records to inspect.";
    const fileRefs = files.map((file) => `'${file.id.replace(/'/g, "''")}'`).join(", ");
    return [
        `SELECT id, path, repo, repository FROM file WHERE id IN (${fileRefs});`,
        `SELECT e.id, e.evidence, e.path_seen, e.ts, f.id AS file_id, f.path AS file_path,
       tc.id AS tool_call_id, tc.name AS tool_name, tc.command_norm, tc.turn, tc.session
FROM read_file e JOIN file f ON f.id = e.out_id JOIN tool_call tc ON tc.id = e.in_id
WHERE e.out_id IN (${fileRefs}) ORDER BY e.ts DESC LIMIT 40;`,
        `SELECT e.id, e.evidence, e.path_seen, e.ts, f.id AS file_id, f.path AS file_path,
       tc.id AS tool_call_id, tc.name AS tool_name, tc.command_norm, tc.turn, tc.session
FROM searched_file e JOIN file f ON f.id = e.out_id JOIN tool_call tc ON tc.id = e.in_id
WHERE e.out_id IN (${fileRefs}) ORDER BY e.ts DESC LIMIT 40;`,
        `SELECT mf.id, mf.source, mf.confidence, mf.ts, f.id AS file_id, f.path AS file_path,
       t.id AS turn_id, t.session, t.seq, t.intent_kind, t.text_excerpt
FROM mentioned_file mf JOIN file f ON f.id = mf.out_id JOIN turn t ON t.id = mf.in_id
WHERE mf.out_id IN (${fileRefs}) ORDER BY mf.ts DESC LIMIT 40;`,
        `SELECT t.session AS session, f.path AS file, count(*) AS edit_count, max(e.ts) AS last_seen
FROM edited e JOIN turn t ON t.id = e.in_id JOIN file f ON f.id = e.out_id
WHERE e.out_id IN (${fileRefs}) GROUP BY t.session, f.path
ORDER BY edit_count DESC, last_seen DESC LIMIT 40;`,
        `SELECT tt.id, tt.additions, tt.deletions, tt.ts, f.id AS file_id, f.path AS file_path,
       c.sha, c.message, c.author, c.ts AS commit_ts
FROM touched tt JOIN file f ON f.id = tt.out_id JOIN "commit" c ON c.id = tt.in_id
WHERE tt.out_id IN (${fileRefs}) ORDER BY tt.ts DESC LIMIT 40;`,
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

export const buildFileContextPack = (input: BuildFileContextInput): Effect.Effect<FileContextPack, CacheReadError, CacheRead> =>
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
