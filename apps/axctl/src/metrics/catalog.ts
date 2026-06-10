import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { readFragilityCascade, type CascadeEdge } from "./fragility-cascade.ts";

export type SignalKind = "relation" | "aggregate";

export interface SignalDescriptor {
    readonly id: string;
    readonly kind: SignalKind;
    readonly label: string;
    readonly description: string;
}

export const SIGNAL_CATALOG: readonly SignalDescriptor[] = [
    {
        id: "fragility_cascade",
        kind: "relation",
        label: "Fragility cascade",
        description:
            "Sessions whose reverted commits' files later forced edits by OTHER sessions (origin -> downstream, weighted by distinct downstream fixers). Precomputed by the derive-metrics ingest stage.",
    },
];

export const findSignal = (id: string): SignalDescriptor | undefined =>
    SIGNAL_CATALOG.find((s) => s.id === id);

/** Run a relation signal by id → its edges. (Only fragility_cascade today.)
 *  Reads the derive-stage precompute - NO live edge derefs on this path. */
export const runRelationSignal = (
    id: string,
): Effect.Effect<readonly CascadeEdge[], DbError, SurrealClient> => {
    switch (id) {
        case "fragility_cascade":
            return readFragilityCascade();
        default:
            return Effect.succeed([]);
    }
};
