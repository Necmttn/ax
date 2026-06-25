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

/**
 * The single dispatcher entry. One spawn runs EVERY guard for an event (decode
 * once -> run matching guards in-process -> merge -> encode once), replacing N
 * fat per-guard bundles. Scaffolded as `dispatch.ts` (source) / `dispatch.js`
 * (binary, embedded like the per-guard bundles) and fired as `bun dispatch.*`.
 */
export const DISPATCHER_NAME = "dispatch";

export const dispatcherScaffoldContent = (): string =>
    `import { runDispatchMain } from "@ax/hooks-sdk/dispatch";\n\nif (import.meta.main) void runDispatchMain();\n`;

/**
 * The daemon-first shim (`ax hooks install --all --daemon`). POSTs the event to
 * the running `ax serve` `/hooks/eval` (warm) and applies its outcome; falls
 * back to the sibling dispatch bundle when the daemon is down. Effect-free on
 * the fast path. `dispatchExt` is the sibling dispatcher's extension - `ts` for
 * the source scaffold, `js` for the embedded binary bundle - so the runtime
 * fallback import resolves the right file next to the shim.
 */
export const SHIM_NAME = "dispatch-shim";

export const shimScaffoldContent = (dispatchExt: "ts" | "js"): string =>
    `import { runShim } from "@ax/hooks-sdk/shim-core";\n\nif (import.meta.main) void runShim({ fallbackUrl: new URL("./${DISPATCHER_NAME}.${dispatchExt}", import.meta.url) });\n`;
