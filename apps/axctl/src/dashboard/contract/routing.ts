/**
 * Handlers for the routing group of the Insights Surface Contract.
 *
 * Write endpoints for routing classes: upsert and delete by id. Both
 * operate on `~/.ax/hooks/routing-table.json` (the same file the
 * route-dispatch hook and `ax routing show/compile` manage).
 *
 * Regex validation is done before touching the file so callers get a clean
 * BadRequestError instead of a corrupt table on disk.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AxApi, BadRequestError } from "@ax/lib/shared/api-contract";
import { DEFAULT_ROUTING_TABLE } from "@ax/hooks-sdk/routing-table";
import {
    defaultRoutingTablePath,
    loadStoredRoutingTable,
    mergeRoutingTables,
    removeUserClass,
    saveStoredRoutingTable,
    type StoredRoutingClass,
    upsertUserClass,
} from "../../queries/routing-table-io.ts";
import { asJsonValue, orInternal } from "./common.ts";

/**
 * Loopback gate: routing writes mutate `routing-table.json`, which the live
 * route-dispatch hook reads. They are allowed only when the daemon is bound to
 * a loopback host (the default). If the operator opted into LAN exposure via
 * `AX_SERVE_HOST=0.0.0.0` (or any non-loopback host), the write surface stays
 * read-only so a networked daemon can't have its routing rewritten remotely.
 * Mirrors how `server.ts` reads the bind host (`process.env.AX_SERVE_HOST`).
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", ""]);
export const writesAllowed = (): boolean => {
    const host = (process.env.AX_SERVE_HOST ?? "").trim();
    return LOOPBACK_HOSTS.has(host);
};
const NON_LOOPBACK_WRITE_ERROR =
    "routing writes are loopback-only; the daemon is bound to a non-loopback host (AX_SERVE_HOST), so the routing table is read-only over the network";

/**
 * Try compiling a regex; return the error message on failure, null on success.
 */
const tryRegex = (pattern: string, flags: string | undefined): string | null => {
    try {
        new RegExp(pattern, flags ?? "");
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
};

export const RoutingGroupLive = HttpApiBuilder.group(AxApi, "routing", (handlers) =>
    handlers
        .handle("routingUpsertClass", ({ payload }) => {
            if (!writesAllowed()) {
                return Effect.fail(new BadRequestError({ error: NON_LOOPBACK_WRITE_ERROR }));
            }
            // Validate main pattern before touching the file.
            const patternErr = tryRegex(payload.pattern, payload.flags);
            if (patternErr !== null) {
                return Effect.fail(new BadRequestError({ error: `invalid pattern: ${patternErr}` }));
            }
            // Validate each exclude pattern.
            for (const ex of payload.exclude ?? []) {
                const exErr = tryRegex(ex, payload.flags);
                if (exErr !== null) {
                    return Effect.fail(
                        new BadRequestError({ error: `invalid exclude pattern "${ex}": ${exErr}` }),
                    );
                }
            }

            const path = defaultRoutingTablePath();
            return orInternal(Effect.gen(function* () {
                const existing = yield* loadStoredRoutingTable(path);
                // mergeRoutingTables converts LoadedRoutingTable → StoredRoutingTable
                // (adds definite origin tags) while refreshing default-origin rows.
                const base = mergeRoutingTables(DEFAULT_ROUTING_TABLE, existing);
                const cls: Omit<StoredRoutingClass, "origin"> = {
                    id: payload.id,
                    pattern: payload.pattern,
                    flags: payload.flags ?? "",
                    suggest: payload.suggest,
                    reason: payload.reason ?? "",
                    ...(payload.exclude !== undefined ? { exclude: payload.exclude } : {}),
                };
                const next = upsertUserClass(base, cls);
                yield* saveStoredRoutingTable(path, next);
                return asJsonValue(next);
            }));
        })
        .handle("routingRemoveClass", ({ params }) => {
            if (!writesAllowed()) {
                return Effect.fail(new BadRequestError({ error: NON_LOOPBACK_WRITE_ERROR }));
            }
            const path = defaultRoutingTablePath();
            return orInternal(Effect.gen(function* () {
                const existing = yield* loadStoredRoutingTable(path);
                if (existing === null) {
                    // File does not exist yet - nothing to remove.
                    return asJsonValue({ removed: false, id: params.id });
                }
                const base = mergeRoutingTables(DEFAULT_ROUTING_TABLE, existing);
                const next = removeUserClass(base, params.id);
                yield* saveStoredRoutingTable(path, next);
                return asJsonValue(next);
            }));
        }));
