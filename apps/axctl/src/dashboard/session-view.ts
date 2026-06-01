/**
 * Session View owns the richer read shape used by `ax session show`: base
 * session detail plus optional child expansion and skill-by-role grouping.
 */

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import type {
    SessionDetailPayload,
    SessionLink,
    SessionSkillRoleGroup,
    SessionTopSkill,
    SessionViewPayload,
} from "@ax/lib/shared/dashboard-types";
import { runQuery } from "@ax/lib/shared/graph-query";
import {
    sessionSkillRolesQuery,
    type SessionSkillRoleEdge,
} from "../queries/session-view.ts";
import { fetchSessionDetail } from "./session-detail.ts";

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
}

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
): Effect.Effect<ReadonlyArray<SessionSkillRoleGroup>, never, SurrealClient> =>
    Effect.gen(function* () {
        const skillNames = topSkills.map((s) => s.skill);
        const roleEdgesRaw = yield* runQuery(sessionSkillRolesQuery, { skillNames });
        const roleEdges = roleEdgesRaw.filter(
            (edge): edge is SessionSkillRoleEdge => edge !== null,
        );
        return groupSessionSkillsByRole(topSkills, roleEdges);
    });

/**
 * Fetches the Session View for a primary session. This is the bounded
 * tracer-bullet shape: it reuses Session Detail for base facts, adds child
 * expansion, and owns by-role grouping without moving the web route yet.
 */
export const fetchSessionView: (
    opts: FetchSessionViewOptions,
) => Effect.Effect<SessionViewPayload, DbError, SurrealClient> = Effect.fn(
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

    const [expanded, byRole] = yield* Effect.all([expandedEffect, byRoleEffect], {
        concurrency: 2,
    });

    return {
        session: primary,
        expanded_subagents: expanded,
        by_role: byRole,
    };
});
