/**
 * `ax usage` - your ax utilization: commands/day, active days, top commands,
 *   agent-vs-tty split, and the never-used surface.
 *
 *   ax usage [--days=N] [--json]
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { fetchInvocations, rollup, type UsageRollup } from "../../usage/query.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { jsonFlag } from "./shared.ts";
import { VISIBLE_COMMANDS } from "./visible-commands.ts";

const renderCommandCounts = (commands: UsageRollup["topCommands"]): string =>
    commands
        .map((c) => `  ${c.command.padEnd(22)} ${String(c.count).padStart(5)}`)
        .join("\n");

/** Render a UsageRollup as a human-readable board. Pure (tested). */
export const renderUsage = (r: UsageRollup): string => {
    if (r.total === 0) return "[ax] no usage recorded yet - run some ax commands, then ingest.";
    const top = renderCommandCounts(r.topCommands.slice(0, 8));
    const topTty = renderCommandCounts(r.topCommandsByOrigin.tty.slice(0, 5)) || "  (none)";
    const topAgent = renderCommandCounts(r.topCommandsByOrigin.agent.slice(0, 5)) || "  (none)";
    const unusedCount = r.unusedSurface.length;
    const unusedList = r.unusedSurface.slice(0, 12).join(", ");
    return [
        `[ax] usage (${r.windowDays}d): ${r.total} runs across ${r.activeDays} active days  (agent ${r.originSplit.agent} / tty ${r.originSplit.tty})`,
        "top commands:",
        top,
        "top tty commands:",
        topTty,
        "top agent/background commands:",
        topAgent,
        `${unusedCount} never used: ${unusedList}`,
    ].join("\n");
};

const cmdUsage = (input: { readonly json: boolean; readonly days: number }) =>
    Effect.gen(function* () {
        const rows = yield* fetchInvocations(input.days);
        const r = rollup(rows, VISIBLE_COMMANDS, input.days);
        console.log(input.json ? prettyPrint(r) : renderUsage(r));
    });

export const usageCommand = Command.make(
    "usage",
    {
        json: jsonFlag,
        days: Flag.integer("days").pipe(Flag.withDefault(30)),
    },
    ({ json, days }) => cmdUsage({ json, days }),
).pipe(
    Command.withDescription(
        "Your ax utilization: commands/day, active days, top commands, agent-vs-tty split, and the never-used surface. --json  --days=N (default 30)",
    ),
);

export const usageRuntime: RuntimeManifest = {
    usage: { runtime: "db", hidden: false },
};
