import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Layer, ManagedRuntime } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { CacheReadLive } from "../duckdb-embed-wiring.ts";
import { JudgmentLive } from "../judgment.ts";

/**
 * Runtime needs are part of each MCP tool's contract.
 *
 * The three narrow kinds carry only what their name says. `full` is the
 * superset - `AppLayer` (AxConfig, ProcessService, tracing, FileSystem, Path)
 * plus both read seams - for tools that need config or git on top of a read.
 * Declaring the narrowest kind that works is what keeps one tool's needs from
 * becoming every tool's, which is how a process-wide union layer hides a live
 * reader.
 */
export type McpRuntimeKind = "cache" | "judgment" | "cache-judgment" | "full";

/**
 * Bun-backed `FileSystem` + `Path`, merged into the cache runtime.
 *
 * A reader can still need the filesystem for a config file that never lived in
 * the database - `dispatches` reads `~/.ax/hooks/routing-table.json` through
 * `loadEffectiveRoutingTable()`. Without these the tool would have to declare
 * `full` and drag in AxConfig, ProcessService and tracing for two file reads.
 * The CLI's own cache runtime (`withCache`, cli/index.ts) merges exactly these
 * two.
 */
const PlatformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const CacheLayer = Layer.merge(CacheReadLive, PlatformLayer);
const JudgmentLayer = JudgmentLive;
const CacheJudgmentLayer = Layer.merge(CacheReadLive, JudgmentLive);
const FullLayer = Layer.mergeAll(AppLayer, CacheReadLive, JudgmentLive);

const RUNTIME_LAYERS = {
    cache: CacheLayer,
    judgment: JudgmentLayer,
    "cache-judgment": CacheJudgmentLayer,
    full: FullLayer,
} as const;

type RuntimeLayer<K extends McpRuntimeKind> = (typeof RUNTIME_LAYERS)[K];

export type McpRuntimeFor<K extends McpRuntimeKind> = ManagedRuntime.ManagedRuntime<
    Layer.Success<RuntimeLayer<K>>,
    Layer.Error<RuntimeLayer<K>>
>;

/** The full runtime remains the type-erased direct-test injection seam. */
export type AxRuntime = McpRuntimeFor<"full">;

export interface McpRuntimePool {
    readonly get: <K extends McpRuntimeKind>(kind: K) => McpRuntimeFor<K>;
    readonly dispose: () => Promise<void>;
}

/**
 * Build runtimes on first tool call, one per exact need set.
 *
 * Registering or listing tools opens no snapshot. A judgment-only request
 * cannot resolve `CacheRead`, even when cache tools are present in the same
 * MCP process.
 */
export const makeMcpRuntimePool = (): McpRuntimePool => {
    let cacheRuntime: McpRuntimeFor<"cache"> | undefined;
    let judgmentRuntime: McpRuntimeFor<"judgment"> | undefined;
    let cacheJudgmentRuntime: McpRuntimeFor<"cache-judgment"> | undefined;
    let fullRuntime: McpRuntimeFor<"full"> | undefined;

    const get = <K extends McpRuntimeKind>(kind: K): McpRuntimeFor<K> => {
        switch (kind) {
            case "cache":
                cacheRuntime ??= ManagedRuntime.make(CacheLayer);
                return cacheRuntime as unknown as McpRuntimeFor<K>;
            case "judgment":
                judgmentRuntime ??= ManagedRuntime.make(JudgmentLayer);
                return judgmentRuntime as unknown as McpRuntimeFor<K>;
            case "cache-judgment":
                cacheJudgmentRuntime ??= ManagedRuntime.make(CacheJudgmentLayer);
                return cacheJudgmentRuntime as unknown as McpRuntimeFor<K>;
            case "full":
                fullRuntime ??= ManagedRuntime.make(FullLayer);
                return fullRuntime as unknown as McpRuntimeFor<K>;
        }
    };

    const dispose = async (): Promise<void> => {
        await Promise.all([
            cacheRuntime?.dispose(),
            judgmentRuntime?.dispose(),
            cacheJudgmentRuntime?.dispose(),
            fullRuntime?.dispose(),
        ].map((result) => result?.catch(() => undefined)));
        cacheRuntime = undefined;
        judgmentRuntime = undefined;
        cacheJudgmentRuntime = undefined;
        fullRuntime = undefined;
    };

    return { get, dispose };
};
