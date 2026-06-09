import { Effect, Ref } from "effect";
import {
    AX_SESSION_SHARE_SCHEMA_VERSION,
    type AxSessionShare,
    type ShareEvent,
    type ShareFile,
    type ShareGraph,
    type ShareTurn,
} from "./artifact.ts";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import type {
    SessionOverview,
    SessionTokenUsageDetail,
    SessionToolCall,
    SessionTopSkill,
    ToolCallDto,
} from "@ax/lib/shared/dashboard-types";
import { categoryOf } from "@ax/lib/shared/tool-presentation";
import { runQuery, runSingleQuery } from "@ax/lib/shared/graph-query";
import { resolveTurnContent } from "../queries/session-turn-content.ts";
import {
    sessionChildrenQuery,
    sessionOverviewQuery,
    sessionShareFilesQuery,
    sessionShareTimelineQuery,
    sessionShareTurnsQuery,
    sessionShareTurnToolCallsQuery,
    sessionShareHookFiresQuery,
    sessionShareHarnessHooksQuery,
    sessionTokenUsageQuery,
    sessionTurnTokenUsageQuery,
    sessionToolCallsQuery,
    sessionTopSkillsQuery,
    type ShareTurnToolCall,
} from "../queries/session-detail.ts";

export interface ShareArtifactParts {
    readonly axVersion: string;
    readonly exportedAt: string;
    readonly overview: SessionOverview;
    readonly topSkills: ReadonlyArray<SessionTopSkill>;
    readonly toolCalls: ReadonlyArray<SessionToolCall>;
    readonly tokenUsage?: SessionTokenUsageDetail | null;
    readonly turns: ReadonlyArray<ShareTurn>;
    readonly timeline: ReadonlyArray<ShareEvent>;
    readonly files: ReadonlyArray<ShareFile>;
    readonly children?: ReadonlyArray<AxSessionShare>;
    readonly spawnAnchorTurnSeq?: number | null;
    readonly hookFires?: AxSessionShare["hook_fires"];
    readonly harnessHooks?: AxSessionShare["harness_hooks"];
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

/**
 * Best-effort: the seq of the turn whose timestamp is the closest match to a
 * spawn timestamp (within 60s, preferring the turn at-or-just-before the
 * spawn). Mirrors the live inspector's `anchorChildToTurn` so share markers
 * land at the same point. Returns null when nothing matches.
 */
export const anchorChildToTurn = (
    turns: ReadonlyArray<ShareTurn>,
    spawnTs: string | null,
): number | null => {
    if (!spawnTs) return null;
    const spawnMs = new Date(spawnTs).getTime();
    if (!Number.isFinite(spawnMs)) return null;
    let best: number | null = null;
    let bestDelta = Infinity;
    for (const turn of turns) {
        if (!turn.ts) continue;
        const ms = new Date(turn.ts).getTime();
        if (!Number.isFinite(ms)) continue;
        const delta = spawnMs - ms;
        if (delta < -5_000) continue;
        if (Math.abs(delta) > 60_000) continue;
        if (delta < bestDelta) {
            bestDelta = delta;
            best = turn.seq;
        }
    }
    return best;
};

const sumBy = <T>(items: ReadonlyArray<T>, read: (item: T) => number): number =>
    items.reduce((sum, item) => sum + read(item), 0);

const dedupeFilesByPath = (
    files: ReadonlyArray<ShareFile>,
): ReadonlyArray<ShareFile> => {
    const byPath = new Map<string, ShareFile>();
    for (const file of files) {
        if (!byPath.has(file.path)) byPath.set(file.path, file);
    }
    return [...byPath.values()];
};

const makeNode = (
    id: string,
    kind: ShareGraph["nodes"][number]["kind"],
    label: string,
): ShareGraph["nodes"][number] => ({ id, kind, label });

const buildGraph = (
    sessionId: string,
    topSkills: ReadonlyArray<SessionTopSkill>,
    toolCalls: ReadonlyArray<SessionToolCall>,
    files: ReadonlyArray<ShareFile>,
): ShareGraph => {
    const nodeById = new Map<string, ShareGraph["nodes"][number]>();
    const addNode = (node: ShareGraph["nodes"][number]) => {
        if (!nodeById.has(node.id)) nodeById.set(node.id, node);
    };

    const sessionNodeId = `session:${sessionId}`;
    addNode(makeNode(sessionNodeId, "session", sessionId));

    const edges: ShareGraph["edges"] = [
        ...topSkills.map((skill) => {
            const skillNodeId = `skill:${skill.skill}`;
            addNode(makeNode(skillNodeId, "skill", skill.skill));
            return { from: sessionNodeId, to: skillNodeId, label: "used" };
        }),
        ...toolCalls.map((tool) => {
            const toolNodeId = `tool:${tool.label}`;
            addNode(makeNode(toolNodeId, "tool", tool.label));
            return { from: sessionNodeId, to: toolNodeId, label: "called" };
        }),
        ...files.map((file) => {
            const fileNodeId = `file:${file.path}`;
            addNode(makeNode(fileNodeId, "file", file.path));
            return { from: sessionNodeId, to: fileNodeId, label: "changed" };
        }),
    ];

    return {
        nodes: [...nodeById.values()],
        edges,
    };
};

const SUMMARY_MAX = 160;

/**
 * One-line "what this session set out to do", for the share outcome header.
 * The first real user turn's opening sentence (skips control/context/tool
 * turns). For a subagent this is the brief its parent handed it.
 */
const deriveSummary = (turns: ReadonlyArray<ShareTurn>): string | undefined => {
    const task = turns.find(
        (t) =>
            t.role === "user" &&
            (t.message_kind === "task" || t.message_kind === undefined) &&
            t.text.trim().length > 0,
    );
    const raw = (task?.text ?? "").replace(/\s+/g, " ").trim();
    if (raw.length === 0) return undefined;
    const firstSentence = raw.split(/(?<=[.!?])\s/)[0] ?? raw;
    const pick = firstSentence.length >= 20 ? firstSentence : raw;
    return pick.length > SUMMARY_MAX ? `${pick.slice(0, SUMMARY_MAX - 1)}…` : pick;
};

export function buildShareArtifactFromParts(
    parts: ShareArtifactParts,
): AxSessionShare {
    const files = dedupeFilesByPath(parts.files);
    const summary = deriveSummary(parts.turns);
    const tool_calls = sumBy(parts.toolCalls, (tool) => tool.count);
    const failures = sumBy(parts.toolCalls, (tool) => tool.failures);
    const working_style =
        parts.topSkills.length > 0
            ? [`Used ${parts.topSkills.length} skill(s) during the session.`]
            : undefined;

    return {
        schema_version: AX_SESSION_SHARE_SCHEMA_VERSION,
        exported_at: parts.exportedAt,
        ax_version: parts.axVersion,
        session: {
            id: parts.overview.id,
            source: parts.overview.source,
            ...(parts.overview.model ? { model: parts.overview.model } : {}),
            ...(parts.overview.project ? { project: parts.overview.project } : {}),
            ...(parts.overview.cwd ? { repository: parts.overview.cwd } : {}),
            ...(parts.overview.started_at ? { started_at: parts.overview.started_at } : {}),
            ...(parts.overview.ended_at ? { ended_at: parts.overview.ended_at } : {}),
            ...(summary ? { summary } : {}),
        },
        stats: {
            turns: parts.turns.length,
            tool_calls,
            files_changed: files.length,
            skills_used: parts.topSkills.length,
            failures,
        },
        token_usage: parts.tokenUsage ?? null,
        ...(parts.hookFires && parts.hookFires.length > 0 ? { hook_fires: parts.hookFires } : {}),
        ...(parts.harnessHooks && parts.harnessHooks.length > 0 ? { harness_hooks: parts.harnessHooks } : {}),
        turns: parts.turns,
        timeline: parts.timeline,
        files,
        graph: buildGraph(
            parts.overview.id,
            parts.topSkills,
            parts.toolCalls,
            files,
        ),
        derived: {
            ...(working_style ? { working_style } : {}),
        },
        redactions: {
            applied: false,
            rules: [],
        },
        ...(parts.children && parts.children.length > 0
            ? { children: parts.children }
            : {}),
        ...(parts.spawnAnchorTurnSeq !== undefined && parts.spawnAnchorTurnSeq !== null
            ? { spawn_anchor_turn_seq: parts.spawnAnchorTurnSeq }
            : {}),
    };
}

export function normalizeSessionRecordRef(sessionId: string): string | null {
    const bare = sessionId.startsWith("session:⟨") && sessionId.endsWith("⟩")
        ? sessionId.slice("session:⟨".length, -"⟩".length)
        : sessionId.startsWith("session:")
            ? sessionId.slice("session:".length)
            : sessionId;

    if (!SESSION_ID_RE.test(bare)) return null;
    return `session:⟨${bare}⟩`;
}

const isPresent = <T>(value: T | null): value is T => value !== null;

const attachTurnContent = (
    turns: ReadonlyArray<ShareTurn>,
    turnContent: Map<number, ShareTurn["content"]>,
): ReadonlyArray<ShareTurn> =>
    turns.map((turn) => {
        const content = turnContent.get(turn.seq);
        return content ? { ...turn, content } : turn;
    });

const attachTurnTokenUsage = (
    turns: ReadonlyArray<ShareTurn>,
    usages: ReadonlyArray<NonNullable<ShareTurn["token_usage"]>>,
): ReadonlyArray<ShareTurn> => {
    const bySeq = new Map(usages.map((usage) => [usage.seq, usage]));
    return turns.map((turn) => {
        const tokenUsage = bySeq.get(turn.seq);
        return tokenUsage ? { ...turn, token_usage: tokenUsage } : turn;
    });
};

const toShareToolCall = (call: ShareTurnToolCall): ToolCallDto => {
    let input: Record<string, unknown> | null = null;
    if (call.input_json) {
        try {
            const parsed = JSON.parse(call.input_json) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                input = parsed as Record<string, unknown>;
            }
        } catch { /* leave input null */ }
    }
    return {
        seq: call.seq,
        name: call.name,
        category: categoryOf(call.name),
        input,
        command: call.command ?? null,
        // Carry the full stored excerpt (already DB-bounded at ingest). This is
        // only a fallback for calls whose tool_result turn didn't pair into the
        // card; the primary full-output source is the merged tool_result turn.
        output_excerpt: call.output ?? null,
        has_error: call.has_error,
        tokens: null,
    };
};

/**
 * Attach typed `tool_calls` to each turn from its recorded call rows. Replaces
 * the old text-baking (`attachSynthesizedToolText`): tool turns now carry
 * structured data the renderer formats, so live + shared render identically.
 */
export const attachStructuredToolCalls = (
    turns: ReadonlyArray<ShareTurn>,
    toolCalls: ReadonlyArray<ShareTurnToolCall>,
): ReadonlyArray<ShareTurn> => {
    if (toolCalls.length === 0) return turns;
    const bySeq = new Map<number, ShareTurnToolCall[]>();
    for (const call of toolCalls) {
        const list = bySeq.get(call.seq) ?? [];
        list.push(call);
        bySeq.set(call.seq, list);
    }
    return turns.map((turn) => {
        const calls = bySeq.get(turn.seq);
        if (!calls || calls.length === 0) return turn;
        return {
            ...turn,
            tool_calls: calls.map(toShareToolCall),
            ...(turn.has_tool_use === undefined ? { has_tool_use: true } : {}),
        };
    });
};

/** Subagents exported concurrently at each level of the spawn tree. Bounds DB
 *  load so a wide fan-out (100+ subagents) can't stampede the daemon into a
 *  timeout (unbounded recursion previously hung the export). */
const EXPORT_CONCURRENCY = 8;
/** Hard cap on sessions fully exported in one share (root + descendants), so a
 *  pathological orchestration can't produce an unbounded gist or hang. */
const MAX_EXPORTED_SESSIONS = 400;

export interface ExportSessionShareOptions {
    /**
     * Record refs already materialised on the current export path. Guards
     * against re-exporting (or cycling on) a session that appears more than
     * once in the spawn graph. Internal - callers pass nothing.
     */
    readonly visited?: ReadonlySet<string>;
    /** Internal: the parent turn seq this session was spawned at, if any. */
    readonly spawnAnchorTurnSeq?: number | null;
    /** Internal: shared remaining-session budget (cycle/size backstop). */
    readonly budget?: Ref.Ref<number>;
}

export const exportSessionShare = (
    sessionId: string,
    axVersion: string,
    options: ExportSessionShareOptions = {},
): Effect.Effect<AxSessionShare | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const recordRef = normalizeSessionRecordRef(sessionId);
        if (recordRef === null) return null;

        const visited = options.visited ?? new Set<string>();
        if (visited.has(recordRef)) return null;

        // Shared budget across the whole recursion (created once at the root)
        // caps total sessions exported - a cycle/size backstop.
        const budget = options.budget ?? (yield* Ref.make(MAX_EXPORTED_SESSIONS));
        const remaining = yield* Ref.updateAndGet(budget, (n) => n - 1);
        if (remaining < 0) return null;

        const params = { recordRef };
        const [overview, topSkillsRaw, toolCallsRaw, tokenUsage, turnTokenUsageRaw, turnsRaw, timelineRaw, filesRaw, childLinksRaw, turnToolCallsRaw, hookFiresRaw, harnessHooksRaw, turnContent] =
            yield* Effect.all([
                runSingleQuery(sessionOverviewQuery, params),
                runQuery(sessionTopSkillsQuery, params),
                runQuery(sessionToolCallsQuery, params),
                runSingleQuery(sessionTokenUsageQuery, params),
                runQuery(sessionTurnTokenUsageQuery, params),
                runQuery(sessionShareTurnsQuery, params),
                runQuery(sessionShareTimelineQuery, params),
                runQuery(sessionShareFilesQuery, params),
                runQuery(sessionChildrenQuery, params),
                runQuery(sessionShareTurnToolCallsQuery, params),
                runQuery(sessionShareHookFiresQuery, params),
                runQuery(sessionShareHarnessHooksQuery, params),
                resolveTurnContent(sessionId),
            ]);

        if (overview === null) return null;

        // Assign the SPA-only monotonic idx (used for stable DOM ids + jumps).
        const hookFires = hookFiresRaw
            .filter(isPresent)
            .map((fire, idx) => ({ idx, ...fire }));

        // Recurse into spawned subagents. The visited set carries this session
        // so a child that points back never re-expands; leaves return [].
        // Each child's spawn-edge ts is anchored to the nearest parent turn so
        // the viewer can mark where it was launched.
        const shareTurns = turnsRaw.filter(isPresent);
        // Harness hooks: assign idx + anchor each to the nearest turn by ts.
        const harnessHooks = harnessHooksRaw
            .filter(isPresent)
            .map((hook, idx) => ({
                idx,
                ...hook,
                anchor_turn_seq: anchorChildToTurn(shareTurns, hook.ts),
            }));
        const nextVisited = new Set(visited).add(recordRef);
        const childLinks = childLinksRaw.filter(isPresent);
        const children = (
            yield* Effect.all(
                childLinks.map((link) =>
                    exportSessionShare(String(link.session_id), axVersion, {
                        visited: nextVisited,
                        spawnAnchorTurnSeq: anchorChildToTurn(shareTurns, link.ts ?? null),
                        budget,
                    }),
                ),
                // Bounded so a wide fan-out can't stampede the daemon.
                { concurrency: EXPORT_CONCURRENCY },
            )
        ).filter(isPresent);

        // Build turns: attach structured tool calls, usage + content, then drop
        // turns that ended up with no text, no content, and no tool calls (empty
        // assistant / thinking shells) so the shared transcript has no blank rows.
        const turns = attachTurnContent(
            attachTurnTokenUsage(
                attachStructuredToolCalls(shareTurns, turnToolCallsRaw.filter(isPresent)),
                turnTokenUsageRaw.filter(isPresent),
            ),
            turnContent,
        ).filter((turn) =>
            turn.text.length > 0 || turn.content != null || (turn.tool_calls?.length ?? 0) > 0
        );

        return buildShareArtifactFromParts({
            axVersion,
            exportedAt: new Date().toISOString(),
            overview,
            topSkills: topSkillsRaw.filter(isPresent),
            toolCalls: toolCallsRaw.filter(isPresent),
            tokenUsage,
            turns,
            timeline: timelineRaw.filter(isPresent),
            files: filesRaw.filter(isPresent),
            children,
            hookFires,
            harnessHooks,
            ...(options.spawnAnchorTurnSeq != null
                ? { spawnAnchorTurnSeq: options.spawnAnchorTurnSeq }
                : {}),
        });
    });
