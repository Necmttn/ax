import { pathToProjectSlug } from "@ax/lib/shared/project-slug";
import { surrealString } from "@ax/lib/shared/surql";

/**
 * One SQL clause for "session belongs to this project root", shared by the
 * sessions metrics / aggregates / churn and dashboard cost / loc queries.
 *
 * Matches all the ways a session can carry its project identity:
 * - `project = <root>`          providers that store the raw cwd as project
 * - `project = <claude-slug>`   Claude stores `~/.claude/projects` dir slugs
 * - `cwd = <root>`              exact checkout root
 * - `cwd` inside `<root>/`      subdirectory and worktree sessions
 *
 * `fieldPrefix` lets record-deref queries pass `"session."`; queries on the
 * session table itself use the default bare columns.
 */
export const sessionProjectClause = (projectRoot: string, fieldPrefix = ""): string => {
    const root = surrealString(projectRoot);
    const slug = surrealString(pathToProjectSlug(projectRoot));
    const prefix = surrealString(projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`);
    const col = (name: string) => `${fieldPrefix}${name}`;
    return `(${col("project")} = ${root} OR ${col("project")} = ${slug}`
        + ` OR ${col("cwd")} = ${root} OR string::starts_with(${col("cwd")} ?? "", ${prefix}))`;
};
