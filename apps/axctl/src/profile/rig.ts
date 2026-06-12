/**
 * Rig assembly: the user's installed agent setup (skills, hooks, routing
 * table, rules) from already-fetched inputs. Pure - all IO (hook dir glob,
 * CLAUDE.md read) happens at the command layer. rules.count is a documented
 * approximation: markdown list items in the global CLAUDE.md; topics are a
 * v2 classifier job (spec §1).
 */
import type { SkillInvocationRow } from "./queries.ts";

/**
 * Live scopes look like: user, agents-shared, command, unknown,
 * plugin:<id>, project:<name>, project-command:<name>, codex-tool,
 * opencode-tool. Only plugin ids are safe to expose; everything else
 * collapses to "local" - project:<name> scopes carry project names and the
 * profile is aggregates-only (never project names or paths).
 */
export function skillSource(scope: string): string {
    if (scope.startsWith("plugin:")) return scope.slice("plugin:".length);
    return "local";
}

/** Harness tool pseudo-skills (codex-tool, opencode-tool) are not skills. */
export function isToolScope(scope: string): boolean {
    return scope.endsWith("-tool");
}

export function countRules(markdown: string): number {
    return markdown.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
}

export interface RigInputs {
    readonly invocations: ReadonlyArray<SkillInvocationRow>;
    readonly scopes: ReadonlyMap<string, string>;
    readonly hookFiles: ReadonlyArray<string>;
    readonly hasRoutingTable: boolean;
    readonly rulesMarkdown: string | null;
}

export interface Rig {
    readonly skills: ReadonlyArray<{ name: string; source: string; runs_30d: number }>;
    readonly hooks: ReadonlyArray<string>;
    readonly routing_table: boolean;
    readonly rules?: { readonly count: number };
}

export function deriveRig(inputs: RigInputs): Rig {
    const skills = inputs.invocations
        .filter((row) => !isToolScope(inputs.scopes.get(row.skill) ?? "user"))
        .map((row) => ({
            name: row.skill,
            source: skillSource(inputs.scopes.get(row.skill) ?? "user"),
            runs_30d: row.count,
        }));
    const hooks = inputs.hookFiles
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => f.replace(/\.ts$/, ""))
        .sort();
    const rulesCount = inputs.rulesMarkdown === null ? 0 : countRules(inputs.rulesMarkdown);
    return {
        skills,
        hooks,
        routing_table: inputs.hasRoutingTable,
        ...(inputs.rulesMarkdown !== null && rulesCount > 0 ? { rules: { count: rulesCount } } : {}),
    };
}
