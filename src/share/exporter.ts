import { Effect } from "effect";
import {
    AX_SESSION_SHARE_SCHEMA_VERSION,
    type AxSessionShare,
    type ShareEvent,
    type ShareFile,
    type ShareGraph,
    type ShareTurn,
} from "./artifact.ts";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import type {
    SessionOverview,
    SessionToolCall,
    SessionTopSkill,
} from "../lib/shared/dashboard-types.ts";
import { runQuery, runSingleQuery } from "../lib/shared/graph-query.ts";
import { resolveTurnContent } from "../queries/session-turn-content.ts";
import {
    sessionOverviewQuery,
    sessionShareFilesQuery,
    sessionShareTimelineQuery,
    sessionShareTurnsQuery,
    sessionToolCallsQuery,
    sessionTopSkillsQuery,
} from "../queries/session-detail.ts";

export interface ShareArtifactParts {
    readonly axVersion: string;
    readonly exportedAt: string;
    readonly overview: SessionOverview;
    readonly topSkills: ReadonlyArray<SessionTopSkill>;
    readonly toolCalls: ReadonlyArray<SessionToolCall>;
    readonly turns: ReadonlyArray<ShareTurn>;
    readonly timeline: ReadonlyArray<ShareEvent>;
    readonly files: ReadonlyArray<ShareFile>;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

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

export function buildShareArtifactFromParts(
    parts: ShareArtifactParts,
): AxSessionShare {
    const files = dedupeFilesByPath(parts.files);
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
        },
        stats: {
            turns: parts.turns.length,
            tool_calls,
            files_changed: files.length,
            skills_used: parts.topSkills.length,
            failures,
        },
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

export const exportSessionShare = (
    sessionId: string,
    axVersion: string,
): Effect.Effect<AxSessionShare | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const recordRef = normalizeSessionRecordRef(sessionId);
        if (recordRef === null) return null;

        const params = { recordRef };
        const [overview, topSkillsRaw, toolCallsRaw, turnsRaw, timelineRaw, filesRaw, turnContent] =
            yield* Effect.all([
                runSingleQuery(sessionOverviewQuery, params),
                runQuery(sessionTopSkillsQuery, params),
                runQuery(sessionToolCallsQuery, params),
                runQuery(sessionShareTurnsQuery, params),
                runQuery(sessionShareTimelineQuery, params),
                runQuery(sessionShareFilesQuery, params),
                resolveTurnContent(sessionId),
            ]);

        if (overview === null) return null;

        return buildShareArtifactFromParts({
            axVersion,
            exportedAt: new Date().toISOString(),
            overview,
            topSkills: topSkillsRaw.filter(isPresent),
            toolCalls: toolCallsRaw.filter(isPresent),
            turns: attachTurnContent(turnsRaw.filter(isPresent), turnContent),
            timeline: timelineRaw.filter(isPresent),
            files: filesRaw.filter(isPresent),
        });
    });
