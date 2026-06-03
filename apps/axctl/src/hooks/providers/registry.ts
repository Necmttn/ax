import { Context, Layer } from "effect";
import { makeRegistry, type AdapterRegistry } from "../../config-core/registry.ts";
import type { HookProvider } from "./types.ts";
import { claudeProvider } from "./claude.ts";
import { cursorProvider } from "./cursor.ts";
import { codexProvider } from "./codex.ts";
import { opencodeProvider } from "./opencode.ts";

/**
 * The four hook providers ax knows how to read/write. `select(name)` fails with
 * a typed `AdapterNotFoundError` rather than returning `undefined` - same
 * discipline as `ClassifierRegistry`/`StageRegistry`.
 */
export const ALL_HOOK_PROVIDERS: ReadonlyArray<HookProvider> = [
    claudeProvider,
    cursorProvider,
    codexProvider,
    opencodeProvider,
];

export class HookProviderRegistry extends Context.Service<HookProviderRegistry, AdapterRegistry<HookProvider>>()(
    "ax/HookProviderRegistry",
) {}

/** Provide a registry from an explicit provider list (tests pass fixtures). */
export const HookProviderRegistryLive = (
    providers: ReadonlyArray<HookProvider>,
): Layer.Layer<HookProviderRegistry> =>
    Layer.succeed(HookProviderRegistry, makeRegistry("hook-provider", providers));

/** Production registry: the canonical four providers. */
export const HookProviderRegistryDefault: Layer.Layer<HookProviderRegistry> =
    HookProviderRegistryLive(ALL_HOOK_PROVIDERS);
