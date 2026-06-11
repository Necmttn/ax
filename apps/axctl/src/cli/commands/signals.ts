// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { SIGNAL_CATALOG, findSignal, runRelationSignal } from "../../metrics/catalog.ts";
import { cleanSessionId } from "../../metrics/util.ts";
import type { CascadeEdge } from "../../metrics/fragility-cascade.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, positiveLimit } from "./shared.ts";

const formatCascadeEdges = (edges: readonly CascadeEdge[], descriptor: { label: string }): string => {
    if (edges.length === 0) return `${descriptor.label}: no edges (no reverted-commit files have downstream fixers).`;
    const lines: string[] = [];
    lines.push(`${descriptor.label} (${edges.length} edge${edges.length === 1 ? "" : "s"}):`);
    for (const e of edges) {
        lines.push(`  ${cleanSessionId(e.origin)} → ${cleanSessionId(e.downstream)}  (weight ${e.weight})`);
    }
    return lines.join("\n");
};

const cmdSignalsList = Effect.sync(() => {
    const lines = SIGNAL_CATALOG.map(
        (s) => `${s.id}  [${s.kind}]  ${s.label} - ${s.description}`,
    );
    console.log(lines.join("\n"));
});

const cmdSignalsShow = (input: { readonly id: string; readonly limit: number; readonly json: boolean }) =>
    Effect.gen(function* () {
        const descriptor = findSignal(input.id);
        if (descriptor === undefined) {
            const ids = SIGNAL_CATALOG.map((s) => s.id).join(", ");
            fail(`axctl signals show: unknown signal "${input.id}". Valid ids: ${ids}`);
        }
        if (descriptor.kind === "aggregate") {
            console.log("aggregate rendering is a later wave");
            return;
        }
        const all = yield* runRelationSignal(descriptor.id);
        const sorted = [...all].sort((a, b) => b.weight - a.weight).slice(0, input.limit);
        if (input.json) {
            console.log(prettyPrint(sorted));
            return;
        }
        console.log(formatCascadeEdges(sorted, descriptor));
    });

const signalsListCommand = Command.make("list", {}, () => cmdSignalsList).pipe(
    Command.withDescription("Print the signal catalog: one line per signal (id [kind] label - description)."),
);

const signalsShowCommand = Command.make(
    "show",
    {
        id: Argument.string("id"),
        limit: positiveLimit(30),
        json: jsonFlag,
    },
    ({ id, limit, json }) => cmdSignalsShow({ id, limit, json }),
).pipe(Command.withDescription(
    "Render a signal by id. Relation signals (e.g. fragility_cascade) print origin → downstream edges "
    + "sorted by weight (top --limit, default 30). --json for machine output.",
));

export const signalsCommand = Command.make("signals").pipe(
    Command.withDescription("Signal catalog: list (browse) + show <id> (render a cross-session signal, e.g. fragility_cascade)"),
    Command.withSubcommands([
        signalsListCommand,
        signalsShowCommand,
    ]),
);

export const signalsRuntime: RuntimeManifest = {
    signals: "db",
};
