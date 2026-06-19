/**
 * The starter hooks `ax hooks init` scaffolds. Shared, dependency-free, so both
 * the runtime scaffolder (sdk-workspace.ts) and the binary-embed build script
 * (scripts/gen-hooks-embed.ts) agree on the set without pulling in Effect.
 */
export const GUARD_NAMES = [
    "enforce-worktree",
    "enforce-worktree-write",
    // Claude-only: suggests cheaper model when Agent dispatch has no explicit model set.
    // Codex has no Agent-tool dispatch equivalent; this hook is a no-op there.
    "route-dispatch",
    // Claude-only: fires at SessionStart to refresh the quota cache and inject a
    // /dojo nudge when the spend mode is splurge (quota budget resets soon).
    // Codex has no SessionStart equivalent; harmless to scaffold but won't fire.
    "refresh-quota",
] as const;

export type GuardName = (typeof GUARD_NAMES)[number];

/**
 * The starter wrapper for a guard: re-exports the SDK hook as the default
 * export (what `ax hooks install` reads for meta) and self-runs via `runMain`
 * when invoked directly (the `bun <file>` fire path). This is both the on-disk
 * `.ts` source scaffold and the entry the binary-embed build bundles to a
 * standalone `.js`.
 */
export const starterHookContent = (guardName: string): string =>
    `import hook from "@ax/hooks-sdk/hooks/${guardName}";\nimport { runMain } from "@ax/hooks-sdk/define";\n\nexport default hook;\nif (import.meta.main) void runMain(hook);\n`;
