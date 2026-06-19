/**
 * `ax routing impact` - the routing-off vs routing-on receipt, measured per 5h
 * plan window (issue #575). Forward A/B capture:
 *
 *   ax routing impact begin --arm=off|on [--label=...]   # snapshot quota, mark t0
 *   (work a ~5h block)
 *   ax routing impact end                                 # snapshot quota, close block
 *   ...repeat with the other arm, matched work...
 *   ax routing impact report [--share] [--json]           # before/after card
 *
 * Headline: 5h-window utilization consumed per unit work (off vs on). On a fixed
 * plan you don't pay per token - the window is the budget. Token-equiv $ rides
 * along. Quota snapshots come from the same source as `ax quota`.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { defaultQuotaCachePath } from "../../quota/cache.ts";
import { QuotaEnvLive } from "../../quota/quota-env.ts";
import { getQuota } from "../../quota/quota.ts";
import type { QuotaSnapshot } from "../../quota/schema.ts";
import {
    buildImpactReport,
    type BlockInput,
    type WindowEdge,
} from "../../routing-impact/compute.ts";
import {
    beginBlock,
    endBlock,
    completedBlocks,
    RoutingImpactStateError,
} from "../../routing-impact/state.ts";
import {
    defaultStatePath,
    fetchWindowMetrics,
    loadState,
    saveState,
} from "../../routing-impact/io.ts";
import { renderImpact } from "../../routing-impact/format.ts";
import { fail, jsonFlag, optionValue } from "./shared.ts";

const fiveHourEdge = (snap: QuotaSnapshot): WindowEdge | null =>
    snap.five_hour
        ? { utilization: snap.five_hour.utilization, resets_at: snap.five_hour.resets_at }
        : null;

/** Best-effort live quota snapshot (forces a fresh read; falls back to cache). */
const snapshotQuota = Effect.gen(function* () {
    const result = yield* getQuota({
        cachePath: defaultQuotaCachePath(),
        maxAgeSeconds: 0,
        nowMs: Date.now(),
    }).pipe(
        Effect.catch(() => Effect.succeed(null)),
    );
    return result?.snapshot ?? null;
}).pipe(Effect.provide(QuotaEnvLive));

const beginImpactCommand = Command.make(
    "begin",
    {
        arm: Flag.string("arm"),
        label: Flag.string("label").pipe(Flag.optional),
    },
    ({ arm, label }) =>
        Effect.gen(function* () {
            if (arm !== "off" && arm !== "on") {
                fail('ax routing impact begin: --arm must be "off" or "on"');
            }
            const path = defaultStatePath();
            const state = yield* Effect.promise(() => loadState(path));
            const snap = yield* snapshotQuota;
            const next = beginBlock(state, {
                arm: arm as "off" | "on",
                label: optionValue(label),
                startedAt: new Date().toISOString(),
                fiveHour: snap ? fiveHourEdge(snap) : null,
            });
            if (next instanceof RoutingImpactStateError) fail(next.reason);
            yield* Effect.promise(() => saveState(path, next));
            const winPct = snap?.five_hour ? `${Math.round(snap.five_hour.utilization)}%` : "n/a";
            console.log(`routing impact: started "${arm}" block (5h window now at ${winPct}).`);
            console.log("work your block, then: ax routing impact end");
        }),
).pipe(Command.withDescription("Start a work block (snapshots the 5h plan window). --arm=off|on [--label]"));

const endImpactCommand = Command.make(
    "end",
    {},
    () =>
        Effect.gen(function* () {
            const path = defaultStatePath();
            const state = yield* Effect.promise(() => loadState(path));
            const snap = yield* snapshotQuota;
            const next = endBlock(state, {
                endedAt: new Date().toISOString(),
                fiveHour: snap ? fiveHourEdge(snap) : null,
            });
            if (next instanceof RoutingImpactStateError) fail(next.reason);
            yield* Effect.promise(() => saveState(path, next));
            const winPct = snap?.five_hour ? `${Math.round(snap.five_hour.utilization)}%` : "n/a";
            console.log(`routing impact: closed block (5h window now at ${winPct}).`);
            console.log("run the other arm, then: ax routing impact report");
        }),
).pipe(Command.withDescription("Close the open work block (snapshots the 5h plan window)."));

const reportImpactCommand = Command.make(
    "report",
    { share: Flag.boolean("share").pipe(Flag.withDefault(false)), json: jsonFlag },
    ({ share, json }) =>
        Effect.gen(function* () {
            const path = defaultStatePath();
            const state = yield* Effect.promise(() => loadState(path));
            const done = completedBlocks(state);

            // Best-effort DB enrichment: a query failure degrades to zeros rather
            // than killing the receipt (the quota-window core is DB-free).
            const inputs: BlockInput[] = [];
            for (const b of done) {
                const metrics = yield* fetchWindowMetrics(b.started_at, b.ended_at!).pipe(
                    Effect.catch(() => Effect.succeed({ tokenCostUsd: 0, turns: 0 })),
                );
                inputs.push({
                    arm: b.arm,
                    label: b.label,
                    started_at: b.started_at,
                    ended_at: b.ended_at!,
                    fiveHourStart: b.five_hour_start,
                    fiveHourEnd: b.five_hour_end,
                    tokenCostUsd: metrics.tokenCostUsd,
                    dispatchCount: 0,
                    inheritCount: 0,
                    turns: metrics.turns,
                });
            }

            const report = buildImpactReport(inputs);
            if (json) {
                console.log(prettyPrint(report));
                return;
            }
            console.log(renderImpact(report, { share }));
        }),
).pipe(Command.withDescription("Render the off-vs-on receipt. [--share appends the ax plug] [--json]"));

export const routingImpactCommand = Command.make("impact").pipe(
    Command.withDescription(
        "Routing A/B receipt: capture work blocks (begin/end) and compare routing off vs on per 5h plan window (report).",
    ),
    Command.withSubcommands([beginImpactCommand, endImpactCommand, reportImpactCommand]),
);
