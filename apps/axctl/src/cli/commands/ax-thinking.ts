/**
 * `ax thinking` - extended-thinking + reasoning-effort analytics.
 *
 *   ax thinking [--days=N] [--json]
 *     Per-model rollup of Claude thinking volume (blocks/tokens counted from
 *     thinking content blocks at ingest) + Codex reasoning-effort
 *     distribution (session.reasoning_effort from turn_context).
 *
 * Rows ingested before the thinking fields existed read as zero; a re-ingest
 * backfills them (the command prints a hint when everything is zero).
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { fetchThinking } from "../../queries/thinking-analytics.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag } from "./shared.ts";

const pct = (n: number): string =>
    Number.isFinite(n) ? `${n.toFixed(1)}%` : "0.0%";

const num = (n: number): string => n.toLocaleString("en-US");

const cmdThinking = (input: { readonly sinceDays: number; readonly json: boolean }) =>
    Effect.gen(function* () {
        const result = yield* fetchThinking({ sinceDays: input.sinceDays });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        const totalTokens = result.models.reduce((s, m) => s + m.thinking_tokens, 0);
        if (result.models.length === 0 && result.codex_efforts.length === 0) {
            console.log("(no sessions in the requested window)");
            return;
        }

        console.log(
            `${"model".padEnd(28)}  ${"sessions".padStart(8)}  ${"asst_turns".padStart(10)}  ` +
            `${"think_turns".padStart(11)}  ${"think%".padStart(7)}  ${"blocks".padStart(8)}  ` +
            `${"think_tokens".padStart(12)}  ${"tok/turn".padStart(10)}`,
        );
        for (const m of result.models) {
            console.log(
                `${m.model.slice(0, 28).padEnd(28)}  ${num(m.sessions).padStart(8)}  ` +
                `${num(m.assistant_turns).padStart(10)}  ${num(m.thinking_turns).padStart(11)}  ` +
                `${pct(m.thinking_turn_pct).padStart(7)}  ${num(m.thinking_blocks).padStart(8)}  ` +
                `${num(m.thinking_tokens).padStart(12)}  ${num(Math.round(m.avg_tokens_per_thinking_turn)).padStart(10)}`,
            );
        }

        if (totalTokens === 0 && result.models.length > 0) {
            console.log(
                "\n(all zero - thinking fields are populated at ingest; run `ax ingest` to backfill the window)",
            );
        }

        if (result.codex_efforts.length > 0) {
            console.log("\ncodex reasoning effort (sessions):");
            for (const e of result.codex_efforts) {
                console.log(
                    `  ${e.model.slice(0, 28).padEnd(28)}  ${e.reasoning_effort.padEnd(8)}  ${num(e.sessions).padStart(8)}`,
                );
            }
        } else {
            console.log(
                "\n(no codex reasoning-effort data - populated at ingest from turn_context; re-ingest to backfill)",
            );
        }

        const reasoningRows = result.codex_reasoning.filter((r) => r.reasoning_tokens > 0);
        if (reasoningRows.length > 0) {
            console.log("\ncodex reasoning tokens (share of output):");
            for (const r of reasoningRows) {
                console.log(
                    `  ${r.model.slice(0, 28).padEnd(28)}  ${num(r.reasoning_tokens).padStart(12)}  ` +
                    `of ${num(r.completion_tokens).padStart(12)}  ${pct(r.reasoning_share_pct).padStart(7)}`,
                );
            }
        }

        console.log(`\n(${result.window_days} days)`);
    });

export const thinkingCommand = Command.make(
    "thinking",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(14)),
        json: jsonFlag,
    },
    ({ days, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax thinking: --days must be a positive integer (got "${days}")`);
        }
        return cmdThinking({ sinceDays: days, json });
    },
).pipe(
    Command.withDescription(
        "Extended-thinking analytics: per-model Claude thinking volume (turns/blocks/tokens) + " +
        "Codex reasoning-effort distribution. --days=N (default 14)  --json",
    ),
);

export const axThinkingRuntime: RuntimeManifest = {
    thinking: {
        runtime: "db",
        hidden: false,
    },
};
