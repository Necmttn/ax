/**
 * Session View owns the richer read shape used by `ax session show`: base
 * session detail plus optional child expansion and skill-by-role grouping.
 */

import { Effect } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import { Judgment, type JudgmentError } from "@ax/lib/sqlite";
import type {
    SessionCompaction,
    SessionDetailPayload,
    SessionLink,
    SessionSkillRoleGroup,
    SessionTopSkill,
    SessionViewPayload,
    SessionViewTurn,
} from "@ax/lib/shared/dashboard-types";
import { runCacheQuery } from "@ax/lib/duckdb/query";
import type { SessionSkillRoleEdge } from "../queries/session-view.ts";
import {
    sessionCompactionsCacheQuery,
    sessionShareTurnsCacheQuery,
} from "../queries/session-detail-cache.ts";
import type { ShareTurn } from "../share/artifact.ts";
import { fetchSessionDetail } from "./session-detail.ts";
import { fetchSkillRoleEdgesByNames } from "./role-queries.ts";

// The id-validation-then-splice guard that used to live here is gone with the
// statement text it protected: `queries/session-detail-cache.ts` binds the id,
// so an unparseable id matches no row instead of needing a pre-check.

const fetchSessionCompactions = (
    sessionId: string,
): Effect.Effect<ReadonlyArray<SessionCompaction>, never, CacheRead> =>
    runCacheQuery(sessionCompactionsCacheQuery, { sessionId });

export type SessionTurnsMode = "excerpt" | "full";

const toSessionViewTurn = (
    turn: ShareTurn,
    mode: SessionTurnsMode,
): SessionViewTurn => {
    const common = {
        seq: turn.seq,
        ts: turn.ts ?? null,
        role: turn.role,
        message_kind: turn.message_kind ?? null,
        intent_kind: turn.intent_kind ?? null,
        has_error: turn.has_error ?? false,
    };
    return mode === "full"
        ? { ...common, text: turn.text }
        : { ...common, text_excerpt: turn.text_excerpt ?? turn.text };
};

const fetchSessionTurns = (
    sessionId: string,
    mode: SessionTurnsMode,
): Effect.Effect<ReadonlyArray<SessionViewTurn>, never, CacheRead> =>
    Effect.map(runCacheQuery(sessionShareTurnsCacheQuery, { sessionId }), (rows) =>
        rows.map((turn) => toSessionViewTurn(turn, mode)),
    );

export type { SessionViewPayload } from "@ax/lib/shared/dashboard-types";

export interface FetchSessionViewOptions {
    readonly sessionId: string;
    /**
     * Set of subagent session ids (UUIDs or `claude-subagent-<id>` forms) to
     * expand inline. Loose matching: a child is expanded when its session_id
     * string includes any value in this set.
     */
    readonly expand: ReadonlySet<string>;
    /** When true, expand ALL children regardless of the expand set. */
    readonly expandAll: boolean;
    /**
     * When true, group this session's top skills by their role classifications.
     * Unclassified skills land in a null-role group rendered as
     * "(unclassified)" by CLI callers.
     */
    readonly byRole?: boolean;
    /** Include normalized turns as excerpts or full text. Omitted means no query. */
    readonly turns?: SessionTurnsMode;
}

/**
 * Transport-agnostic input for the Session View shared by CLI and MCP.
 * Protocol decoders may use a boolean (`--turns`) or the explicit text mode;
 * this seam owns presence, trimming, and mode semantics.
 */
export interface SessionViewQueryArgs {
    readonly expand?: ReadonlyArray<string> | undefined;
    readonly expandAll?: boolean | undefined;
    readonly byRole?: boolean | undefined;
    readonly turns?: boolean | SessionTurnsMode | undefined;
}

export type NormalizedSessionViewInput = Omit<
    FetchSessionViewOptions,
    "sessionId"
>;

export const normalizeSessionViewInput = (
    args: SessionViewQueryArgs,
): NormalizedSessionViewInput => {
    const expand = new Set(
        (args.expand ?? []).map((value) => value.trim()).filter(Boolean),
    );
    const turns = args.turns === true
        ? "excerpt"
        : args.turns === "excerpt" || args.turns === "full"
          ? args.turns
          : undefined;

    return {
        expand,
        expandAll: args.expandAll === true,
        byRole: args.byRole === true,
        ...(turns === undefined ? {} : { turns }),
    };
};

export const selectSessionChildrenToExpand = (
    children: ReadonlyArray<SessionLink>,
    expand: ReadonlySet<string>,
    expandAll: boolean,
): ReadonlyArray<SessionLink> =>
    children.filter((child) => {
        if (expandAll) return true;
        const sid = String(child.session_id ?? "");
        for (const expandId of expand) {
            if (sid.includes(expandId)) return true;
        }
        return false;
    });

export const groupSessionSkillsByRole = (
    topSkills: ReadonlyArray<SessionTopSkill>,
    roleEdges: ReadonlyArray<SessionSkillRoleEdge>,
): ReadonlyArray<SessionSkillRoleGroup> => {
    const skillRoleMap = new Map<string, string[]>();
    for (const edge of roleEdges) {
        const existing = skillRoleMap.get(edge.skill_name);
        if (existing) {
            if (!existing.includes(edge.role_name)) existing.push(edge.role_name);
        } else {
            skillRoleMap.set(edge.skill_name, [edge.role_name]);
        }
    }

    const roleGroupMap = new Map<
        string | null,
        Array<{ readonly skill: string; readonly count: number }>
    >();

    for (const topSkill of topSkills) {
        const roles = skillRoleMap.get(topSkill.skill);
        const role = roles?.[0] ?? null;
        const group = roleGroupMap.get(role) ?? [];
        group.push({ skill: topSkill.skill, count: topSkill.count });
        roleGroupMap.set(role, group);
    }

    const namedGroups: Array<SessionSkillRoleGroup & { readonly totalCount: number }> = [];
    let unclassifiedGroup: SessionSkillRoleGroup | null = null;

    for (const [role, skills] of roleGroupMap) {
        const totalCount = skills.reduce((sum, s) => sum + s.count, 0);
        if (role === null) {
            unclassifiedGroup = { role: null, skills };
        } else {
            namedGroups.push({ role, skills, totalCount });
        }
    }

    namedGroups.sort((a, b) => b.totalCount - a.totalCount);

    const groups: SessionSkillRoleGroup[] = namedGroups.map(({ role, skills }) => ({
        role,
        skills,
    }));
    if (unclassifiedGroup) groups.push(unclassifiedGroup);
    return groups;
};

const fetchSessionSkillRoleGroups = (
    topSkills: ReadonlyArray<SessionTopSkill>,
): Effect.Effect<ReadonlyArray<SessionSkillRoleGroup>, CacheReadError | JudgmentError, CacheRead | Judgment> =>
    Effect.gen(function* () {
        const skillNames = topSkills.map((s) => s.skill);
        const roleEdges = yield* fetchSkillRoleEdgesByNames(skillNames);
        return groupSessionSkillsByRole(topSkills, roleEdges);
    });

/**
 * Fetches the Session View for a primary session. This is the bounded
 * tracer-bullet shape: it reuses Session Detail for base facts, adds child
 * expansion, and owns by-role grouping without moving the web route yet.
 */
export const fetchSessionView: (
    opts: FetchSessionViewOptions,
) => Effect.Effect<SessionViewPayload, CacheReadError | JudgmentError, CacheRead | Judgment> = Effect.fn(
    "fetchSessionView",
)(function* (opts) {
    const primary = yield* fetchSessionDetail(opts.sessionId);
    const childrenToExpand = selectSessionChildrenToExpand(
        primary.children,
        opts.expand,
        opts.expandAll,
    );

    const expandedEffect =
        childrenToExpand.length === 0
            ? Effect.succeed([] as ReadonlyArray<SessionDetailPayload>)
            : Effect.all(
                  childrenToExpand.map((child) =>
                      fetchSessionDetail(String(child.session_id)),
                  ),
                  { concurrency: "unbounded" },
              );

    const byRoleEffect =
        opts.byRole === true && primary.top_skills.length > 0
            ? fetchSessionSkillRoleGroups(primary.top_skills)
            : Effect.succeed(null);

    const compactionsEffect = fetchSessionCompactions(opts.sessionId);
    const turnsEffect = opts.turns === undefined
        ? Effect.succeed(null)
        : fetchSessionTurns(opts.sessionId, opts.turns);

    const [expanded, byRole, compactions, turns] = yield* Effect.all(
        [expandedEffect, byRoleEffect, compactionsEffect, turnsEffect],
        { concurrency: 4 },
    );

    return {
        session: primary,
        expanded_subagents: expanded,
        by_role: byRole,
        compactions,
        ...(turns === null ? {} : { turns }),
    };
});
