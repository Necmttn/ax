import { Layer, ManagedRuntime } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { CacheReadLive } from "@ax/lib/duckdb/seam";
import { JudgmentLive } from "../judgment.ts";

/**
 * Runtime needs are part of each MCP tool's contract.
 *
 * `legacy` is temporary for tools whose read query still uses SurrealDB. The
 * other three values exclude `AppLayer`, so those requests never construct a
 * SurrealDB client. This keeps the cutover incremental without hiding a live
 * reader behind a process-wide union layer.
 */
export type McpRuntimeKind = "cache" | "judgment" | "cache-judgment" | "legacy";

const CacheLayer = CacheReadLive;
const JudgmentLayer = JudgmentLive;
const CacheJudgmentLayer = Layer.merge(CacheReadLive, JudgmentLive);
const LegacyLayer = Layer.mergeAll(AppLayer, CacheReadLive, JudgmentLive);

const RUNTIME_LAYERS = {
    cache: CacheLayer,
    judgment: JudgmentLayer,
    "cache-judgment": CacheJudgmentLayer,
    legacy: LegacyLayer,
} as const;

type RuntimeLayer<K extends McpRuntimeKind> = (typeof RUNTIME_LAYERS)[K];

export type McpRuntimeFor<K extends McpRuntimeKind> = ManagedRuntime.ManagedRuntime<
    Layer.Success<RuntimeLayer<K>>,
    Layer.Error<RuntimeLayer<K>>
>;

/** The full runtime remains the type-erased direct-test injection seam. */
export type AxRuntime = McpRuntimeFor<"legacy">;

export interface McpRuntimePool {
    readonly get: <K extends McpRuntimeKind>(kind: K) => McpRuntimeFor<K>;
    readonly dispose: () => Promise<void>;
}

/**
 * Build runtimes on first tool call, one per exact need set.
 *
 * Registering or listing tools opens no database. A cache-only or
 * judgment-only request cannot resolve `AppLayer`, even when legacy tools are
 * present in the same MCP process.
 */
export const makeMcpRuntimePool = (): McpRuntimePool => {
    let cacheRuntime: McpRuntimeFor<"cache"> | undefined;
    let judgmentRuntime: McpRuntimeFor<"judgment"> | undefined;
    let cacheJudgmentRuntime: McpRuntimeFor<"cache-judgment"> | undefined;
    let legacyRuntime: McpRuntimeFor<"legacy"> | undefined;

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
            case "legacy":
                legacyRuntime ??= ManagedRuntime.make(LegacyLayer);
                return legacyRuntime as unknown as McpRuntimeFor<K>;
        }
    };

    const dispose = async (): Promise<void> => {
        await Promise.all([
            cacheRuntime?.dispose(),
            judgmentRuntime?.dispose(),
            cacheJudgmentRuntime?.dispose(),
            legacyRuntime?.dispose(),
        ].map((result) => result?.catch(() => undefined)));
        cacheRuntime = undefined;
        judgmentRuntime = undefined;
        cacheJudgmentRuntime = undefined;
        legacyRuntime = undefined;
    };

    return { get, dispose };
};
