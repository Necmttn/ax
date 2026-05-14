import { Layer } from "effect";
import { AgentctlConfigLive } from "./config.ts";
import { SurrealClientLive } from "./db.ts";
import { ProcessServiceLive } from "./process.ts";

/**
 * Composed application layer. Provides `AgentctlConfig` (env snapshot),
 * `ProcessService` (Bun.spawn wrapper), and the `SurrealClient` (which
 * depends on AgentctlConfig). Future services merge in here.
 */
export const AppLayer = Layer.provide(SurrealClientLive, AgentctlConfigLive).pipe(
    Layer.merge(AgentctlConfigLive),
    Layer.merge(ProcessServiceLive),
);
