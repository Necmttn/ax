/**
 * `ax dojo` - budget envelope + prioritized training agenda for the
 * ax:dojo skill loop. Spec: docs/superpowers/specs/2026-06-13-ax-dojo-design.md
 *
 *   ax dojo            human agenda
 *   ax dojo --json     DojoAgenda JSON (consumed by the skill each lap)
 *
 * The quota snapshot is fetched with error tolerance: if the usage endpoint
 * (and cache) are unavailable, the budget degrades to "unavailable" but the
 * agenda still renders - the items are derived from the local graph, not the
 * quota API.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { assembleAgenda, collectAgendaItems } from "../../dojo/agenda.ts";
import { computeBudgetEnvelope } from "../../dojo/budget.ts";
import { renderAgenda } from "../../dojo/format.ts";
import { defaultQuotaCachePath } from "../../quota/cache.ts";
import { QuotaEnvLive } from "../../quota/quota-env.ts";
import { getQuota } from "../../quota/quota.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { jsonFlag } from "./shared.ts";

/** "HH:MM" today (or tomorrow when already past) -> ISO */
export const untilToIso = (until: string, nowMs: number): string | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(until);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    const d = new Date(nowMs);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return d.toISOString();
};

export const dojoCommand = Command.make(
    "dojo",
    {
        json: jsonFlag,
        budget: Flag.integer("budget").pipe(Flag.withDefault(0)), // 0 = unset
        until: Flag.string("until").pipe(Flag.withDefault("")),
        force: Flag.boolean("force").pipe(Flag.withDefault(false)),
        spar: Flag.boolean("spar").pipe(Flag.withDefault(false)),
        days: Flag.integer("days").pipe(Flag.withDefault(30)),
    },
    ({ json, budget, until, force, spar, days }) => {
        const nowMs = Date.now();
        return Effect.gen(function* () {
            const quota = yield* getQuota({
                cachePath: defaultQuotaCachePath(),
                maxAgeSeconds: 60,
                nowMs,
            }).pipe(
                Effect.map((r) => r.snapshot),
                Effect.catch(() => Effect.succeed(null)), // budget degrades, agenda still renders
            );
            const untilIso = until ? untilToIso(until, nowMs) : null;
            if (until && untilIso === null) {
                console.error("ax dojo: invalid --until, expected HH:MM"); // degrade, don't fail
            }
            const envelope = computeBudgetEnvelope(
                quota,
                {
                    budgetPctOverride: budget > 0 ? budget : null,
                    untilIso,
                    force,
                },
                nowMs,
            );
            const items = yield* collectAgendaItems({ nowMs, days, spar });
            const agenda = assembleAgenda(envelope, items, { nowMs, spar });
            console.log(json ? prettyPrint(agenda) : renderAgenda(agenda));
        }).pipe(Effect.provide(QuotaEnvLive));
    },
).pipe(
    Command.withDescription(
        "Training agenda: quota budget envelope + prioritized self-improvement work items (--budget=N, --until=HH:MM, --spar, --force, --days=N, --json; consumed by the ax:dojo skill loop)",
    ),
);

export const dojoRuntime: RuntimeManifest = {
    dojo: "db",
};
