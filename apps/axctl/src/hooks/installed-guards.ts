import type { ConfiguredHook } from "./providers/types.ts";

const ROUTE_DISPATCH_COMMAND = /(?:^|[/\\])(?:route-dispatch|dispatch|dispatch-shim)\.(?:[cm]?[jt]s)(?:["']|\s|$)/;
const stripAxMarker = (command: string): string =>
    command.replace(/\s*#\s*ax:[a-z0-9_-]+\s*$/, "");

const matcherIncludesAgent = (matcher: string | null): boolean =>
    matcher !== null && matcher.split("|").some((tool) => tool.trim() === "Agent");

/** True when live Claude configuration runs route-dispatch for PreToolUse:Agent. */
export const hasActiveClaudeRouteDispatch = (
    hooks: ReadonlyArray<ConfiguredHook>,
): boolean => hooks.some((hook) =>
    hook.enabled &&
    hook.provider === "claude" &&
    hook.event === "PreToolUse" &&
    matcherIncludesAgent(hook.matcher) &&
    ROUTE_DISPATCH_COMMAND.test(stripAxMarker(hook.command)),
);
