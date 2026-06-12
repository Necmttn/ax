export { defineHook, matches, runHook, runMain, type HookDefinition } from "./define.ts";
export { Verdict } from "./verdict.ts";
export type { Harness, HookEvent, HookEventName } from "./event.ts";
export { GitEnv, GitEnvLive, GitEnvTest, type GitEnvService } from "./git-env.ts";
export {
  DEFAULT_ROUTING_TABLE,
  RoutingClassSchema,
  RoutingTableSchema,
  defaultRoutingTablePath,
  loadRoutingTableOrDefault,
  loadStoredRoutingTable,
  parseStoredRoutingTable,
  readRoutingTableSync,
  type ClassOrigin,
  type LoadedRoutingClass,
  type LoadedRoutingTable,
  type RoutingClass,
  type RoutingTable,
  type RoutingTableShape,
} from "./routing-table.ts";
