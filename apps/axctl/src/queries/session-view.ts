/**
 * Query fragments for the fuller Session View read shape. These sit above the
 * base session-detail queries and keep extra view semantics, such as skill
 * role edges, behind the typed query seam.
 */

import { defineQuery } from "@ax/lib/shared/query";
import { isRecord, stringField } from "@ax/lib/shared/row-fields";

export interface SessionSkillRoleParams {
    readonly skillNames: ReadonlyArray<string>;
}

export interface SessionSkillRoleEdge {
    readonly skill_name: string;
    readonly role_name: string;
}

export const SESSION_SKILL_ROLES_SQL = `
SELECT
    in.name AS skill_name,
    out.name AS role_name
FROM plays_role
WHERE in.name IN $skills
    AND source IN ["frontmatter", "brief", "user"];`;

export const sessionSkillRolesQuery = defineQuery<
    SessionSkillRoleParams,
    Record<string, unknown>,
    SessionSkillRoleEdge | null
>({
    name: "session-view.skill_roles",
    sql: () => SESSION_SKILL_ROLES_SQL.trim(),
    bindings: (params) => ({ skills: [...params.skillNames] }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const skill_name = stringField(raw, "skill_name");
        const role_name = stringField(raw, "role_name");
        if (!skill_name || !role_name) return null;
        return { skill_name, role_name };
    },
});
