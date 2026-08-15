/**
 * Query fragments for the fuller Session View read shape. These sit above the
 * base session-detail queries and keep extra view semantics, such as skill
 * role edges, behind the typed query seam.
 */

export interface SessionSkillRoleEdge {
    readonly skill_name: string;
    readonly role_name: string;
}
