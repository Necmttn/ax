/**
 * Handler for the usage group of the Insights Surface Contract.
 * GET /api/usage → fetchInvocations + rollup → UsageRollupSchema.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AxApi } from "@ax/lib/shared/api-contract";
import { VISIBLE_COMMANDS } from "../../cli/commands/visible-commands.ts";
import { fetchInvocations, rollup } from "../../usage/query.ts";
import { orInternal } from "./common.ts";

export const UsageGroupLive = HttpApiBuilder.group(AxApi, "usage", (handlers) =>
    handlers
        .handle("usageRollup", ({ query }) => {
            const windowDays = query.days ?? 30;
            return orInternal(
                fetchInvocations(windowDays).pipe(
                    Effect.map((rows) => rollup(rows, VISIBLE_COMMANDS, windowDays)),
                ),
            );
        }),
);
