/**
 * P2.2 / P3.7: ax session show - combined data fetcher.
 *
 * Pure data helper. Fetches the primary session detail plus one
 * fetchSessionDetail call per requested expansion. All calls run in parallel
 * via Effect.all.
 *
 * P3.7 extends this with optional byRole fetch: when byRole=true, the
 * payload includes a by_role array grouping invoked skills by their roles.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { fetchSessionDetail } from "./session-detail.ts";
import type { SessionDetailPayload } from "../lib/shared/dashboard-types.ts";
import type { ByRoleGroup } from "../cli/role-format.ts";

export interface SessionShowPayload {
    /** Primary session detail. */
    readonly session: SessionDetailPayload;
    /**
     * Expanded subagent details, one entry per UUID in the `expand` set that
     * matched a child. Order mirrors the order of `session.children`.
     */
    readonly expanded_subagents: ReadonlyArray<SessionDetailPayload>;
    /**
     * P3.7: When byRole=true in the fetch options, this is populated with
     * skills grouped by role. Skills without a role land in a null-role group
     * labelled "(unclassified)".
     */
    readonly by_role: ReadonlyArray<ByRoleGroup> | null;
}

export interface FetchSessionShowOptions {
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
     * P3.7: When true, fetch plays_role edges for the session's top_skills
     * and group them into by_role on the payload.
     */
    readonly byRole?: boolean;
}

/**
 * Fetches session detail for the primary session plus any requested
 * subagent expansions. All DB calls run in parallel.
 *
 * Returns `null` for `session.overview` when the session does not exist -
 * the caller should surface that as "not found".
 *
 * P3.7: When opts.byRole=true, also fetches plays_role edges for the
 * session's top_skills and builds the by_role grouping.
 */
export const fetchSessionShow = (
    opts: FetchSessionShowOptions,
): Effect.Effect<SessionShowPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const primary = yield* fetchSessionDetail(opts.sessionId);

        // Determine which children to expand
        const childrenToExpand = primary.children.filter((child) => {
            if (opts.expandAll) return true;
            const sid = String(child.session_id ?? "");
            for (const expandId of opts.expand) {
                if (sid.includes(expandId)) return true;
            }
            return false;
        });

        const expandedPromise =
            childrenToExpand.length === 0
                ? Effect.succeed([])
                : Effect.all(
                      childrenToExpand.map((child) =>
                          fetchSessionDetail(String(child.session_id)),
                      ),
                      { concurrency: "unbounded" },
                  );

        // P3.7: optional by-role grouping
        const byRolePromise: Effect.Effect<
            ReadonlyArray<ByRoleGroup> | null,
            DbError,
            never
        > = opts.byRole && primary.top_skills.length > 0
            ? Effect.gen(function* () {
                  // Fetch plays_role edges for all skills in this session
                  const skillNames = primary.top_skills.map((s) => s.skill);
                  const sql = `
SELECT
    in.name AS skill_name,
    out.name AS role_name
FROM plays_role
WHERE in.name IN $skills
    AND source IN ["frontmatter", "brief", "user"];`.trim();
                  const result = yield* db.query<[Array<Record<string, unknown>>]>(
                      sql,
                      { skills: skillNames },
                  );
                  const roleEdges = (result?.[0] ?? []) as Array<
                      Record<string, unknown>
                  >;

                  // Build skill -> roles map
                  const skillRoleMap = new Map<string, string[]>();
                  for (const edge of roleEdges) {
                      const skill = String(edge.skill_name ?? "");
                      const role = String(edge.role_name ?? "");
                      if (!skill || !role) continue;
                      const existing = skillRoleMap.get(skill);
                      if (existing) {
                          if (!existing.includes(role)) existing.push(role);
                      } else {
                          skillRoleMap.set(skill, [role]);
                      }
                  }

                  // Group top_skills by role
                  const roleGroupMap = new Map<
                      string | null,
                      Array<{ skill: string; count: number }>
                  >();

                  for (const topSkill of primary.top_skills) {
                      const roles = skillRoleMap.get(topSkill.skill);
                      if (!roles || roles.length === 0) {
                          // unclassified
                          const g = roleGroupMap.get(null) ?? [];
                          g.push({ skill: topSkill.skill, count: topSkill.count });
                          roleGroupMap.set(null, g);
                      } else {
                          // Assign to first role (primary role)
                          const role = roles[0]!;
                          const g = roleGroupMap.get(role) ?? [];
                          g.push({ skill: topSkill.skill, count: topSkill.count });
                          roleGroupMap.set(role, g);
                      }
                  }

                  // Sort groups: named roles first by total count DESC, then (unclassified)
                  const namedGroups: ByRoleGroup[] = [];
                  let unclassifiedGroup: ByRoleGroup | null = null;

                  for (const [role, skills] of roleGroupMap) {
                      const totalCount = skills.reduce(
                          (sum, s) => sum + s.count,
                          0,
                      );
                      if (role === null) {
                          unclassifiedGroup = { role: null, skills };
                      } else {
                          namedGroups.push({ role, skills, _totalCount: totalCount } as ByRoleGroup & { _totalCount: number });
                      }
                  }

                  namedGroups.sort(
                      (a, b) =>
                          ((b as unknown as { _totalCount: number })._totalCount ?? 0) -
                          ((a as unknown as { _totalCount: number })._totalCount ?? 0),
                  );

                  const groups: ByRoleGroup[] = namedGroups.map(({ role, skills }) => ({
                      role,
                      skills,
                  }));
                  if (unclassifiedGroup) groups.push(unclassifiedGroup);

                  return groups;
              }).pipe(
                  Effect.provideService(SurrealClient, db),
              )
            : Effect.succeed(null);

        const [expanded, byRole] = yield* Effect.all([expandedPromise, byRolePromise], {
            concurrency: 2,
        });

        return {
            session: primary,
            expanded_subagents: expanded,
            by_role: byRole,
        };
    });
