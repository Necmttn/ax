/**
 * Ingest Pipeline: dependency-graph scheduler for Ingest Stages.
 *
 * Each stage declares the stages it depends on. `topoLayers` turns the graph
 * into ordered layers - every stage in a layer is independent of the others in
 * that layer, so the runner executes a layer concurrently. The pipeline owns
 * ordering + parallelism; stage logic stays in the stage modules.
 *
 * Replaces the hardcoded `if (sel.has(...))` dispatch in cli/index.ts. Adding a
 * stage is one `StageSpec`; `claude`/`codex` run in parallel because neither
 * lists the other as a dep; `subagents` lists both, so it lands in a later
 * layer automatically.
 */

import { Effect } from "effect";
import type { DbError } from "../lib/errors.ts";

/** A single Ingest Stage. `run` is the stage's Effect; `deps` are the keys of
 *  stages that must complete before this one starts. */
export interface StageSpec {
    readonly key: string;
    readonly deps: readonly string[];
    readonly run: () => Effect.Effect<unknown, DbError, never>;
}

/** Max stages run concurrently within one layer. Caps DB write pressure even
 *  if a layer is wide. */
export const LAYER_CONCURRENCY = 2;

/**
 * Compute execution layers via Kahn's algorithm. Layer N contains every stage
 * whose deps are all satisfied by layers < N. Throws only on a dependency
 * cycle. Deps that reference stages outside `specs` are treated as already
 * satisfied (the caller is responsible for ensuring those rows exist in the
 * DB - e.g. `--stages=signals` assumes transcript rows are already ingested).
 */
export const topoLayers = (specs: readonly StageSpec[]): string[][] => {
    const byKey = new Map(specs.map((s) => [s.key, s]));
    const inGraph = (d: string): boolean => byKey.has(d);
    const done = new Set<string>();
    const layers: string[][] = [];
    let remaining = [...specs];
    while (remaining.length > 0) {
        const ready = remaining.filter((s) =>
            s.deps.filter(inGraph).every((d) => done.has(d)),
        );
        if (ready.length === 0) {
            throw new Error(
                `ingest pipeline: dependency cycle among ${remaining
                    .map((s) => s.key)
                    .join(", ")}`,
            );
        }
        layers.push(ready.map((s) => s.key));
        for (const s of ready) done.add(s.key);
        remaining = remaining.filter((s) => !done.has(s.key));
    }
    return layers;
};

/**
 * Run the selected stages in dependency order. Stages within a layer run
 * concurrently (capped at {@link LAYER_CONCURRENCY}); layers run sequentially.
 * The first failing stage fails the pipeline.
 */
export const runPipeline = (
    specs: readonly StageSpec[],
): Effect.Effect<void, DbError, never> =>
    Effect.gen(function* () {
        const byKey = new Map(specs.map((s) => [s.key, s]));
        for (const layer of topoLayers(specs)) {
            yield* Effect.forEach(
                layer,
                (key) => byKey.get(key)!.run(),
                { concurrency: LAYER_CONCURRENCY, discard: true },
            );
        }
    });

/** Canonical Ingest Stage keys → the stages they depend on.
 *
 * Dependency rationale:
 *  - `skills`/`commands` seed skill + command rows; transcript stages link
 *    `invoked` edges to them, so they must precede `claude`/`codex`.
 *  - `claude`/`codex` parse raw transcripts; independent of each other.
 *  - `subagents` derives parent↔child links - needs both transcript stages.
 *  - `spawned` derives spawn edges from transcript rows.
 *  - `git` is independent of transcripts.
 *  - the derive-* stages re-read already-ingested turn/session rows.
 *  - `harness` (doctor) reads everything; runs last.
 */
export const INGEST_STAGE_DEPS: Record<string, readonly string[]> = {
    skills: [],
    commands: [],
    claude: ["skills", "commands"],
    codex: ["skills", "commands"],
    subagents: ["claude", "codex"],
    spawned: ["claude", "codex"],
    git: [],
    signals: ["claude", "codex", "subagents", "spawned", "git"],
    outcomes: ["signals"],
    "session-health": ["signals"],
    closure: ["signals"],
    "learning-registry": ["signals"],
    harness: ["outcomes", "session-health", "closure", "learning-registry"],
};

export type IngestStageKey = keyof typeof INGEST_STAGE_DEPS;

/** Stages that re-derive purely from already-ingested DB rows - the
 *  `--derive-only` set. Defined as "no dep on a transcript/git parse stage". */
export const deriveOnlyKeys = (): IngestStageKey[] =>
    ["signals", "outcomes", "session-health", "closure", "learning-registry"];

/** Canonical Ingest Stage keys in execution order. Single source of truth. */
export const ALL_STAGE_KEYS = Object.keys(INGEST_STAGE_DEPS) as IngestStageKey[];

/** Validate + return the requested stage keys verbatim. Deps are NOT expanded:
 *  for `--stages=signals` the dep rows are assumed already ingested. Throws on
 *  an unknown key. */
export const selectStages = (keys: readonly string[]): IngestStageKey[] => {
    const bad = keys.filter((k) => !ALL_STAGE_KEYS.includes(k as IngestStageKey));
    if (bad.length > 0) {
        throw new Error(
            `ingest pipeline: unknown stage(s): ${bad.join(", ")}\n` +
                `  valid stages: ${ALL_STAGE_KEYS.join(", ")}`,
        );
    }
    return keys as IngestStageKey[];
};
