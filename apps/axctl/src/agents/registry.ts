import { Context, Effect, Layer } from "effect";
import { makeRegistry, type AdapterRegistry } from "../config-core/registry.ts";
import { projectSource, userSource, type AgentSource } from "./source.ts";

/**
 * Registry of agent-definition sources (user + project), exposed as a
 * Context.Service mirroring how each config-front-door domain holds its
 * adapters. `all()` enumerates sources in precedence order (user first);
 * `select(name)` fails with `AdapterNotFoundError` instead of `undefined`.
 */
export class AgentSourceRegistry extends Context.Service<
    AgentSourceRegistry,
    AdapterRegistry<AgentSource>
>()("ax/AgentSourceRegistry") {}

/** Build a registry over an explicit source list (also used by tests). */
export const makeAgentSourceRegistry = (
    sources: readonly AgentSource[],
): AdapterRegistry<AgentSource> => makeRegistry<AgentSource>("agent-source", sources);

/** Layer for a custom source list (test fixtures). */
export const AgentSourceRegistryFrom = (
    sources: readonly AgentSource[],
): Layer.Layer<AgentSourceRegistry> =>
    Layer.succeed(AgentSourceRegistry, makeAgentSourceRegistry(sources));

/** Production registry: user + project sources, user first. */
export const AgentSourceRegistryLive: Layer.Layer<AgentSourceRegistry> =
    AgentSourceRegistryFrom([userSource, projectSource]);

/** Convenience accessor used by orchestration code. */
export const allAgentSources = (): Effect.Effect<
    readonly AgentSource[],
    never,
    AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const reg = yield* AgentSourceRegistry;
        return reg.all();
    });
