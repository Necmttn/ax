/**
 * POST /api/improve/:sig/:action  (action in accept | reject | verdict)
 * Shared logic lives in src/improve/actions.ts so the CLI and HTTP paths
 * agree on semantics (dynamic import preserved from the legacy handler).
 */
import { Effect, Option, Schema } from "effect";
import {
    decodeFail,
    decodeOk,
    jsonResponse,
    jsonRoute,
    type AnyRoute,
    type Decoded,
    type RouteInput,
} from "../router.ts";
import { fetchNextActionsCached, invalidateNextActionsCache } from "../../read-caches.ts";

const decodeAction = Schema.decodeUnknownOption(
    Schema.Literals(["accept", "reject", "verdict"]),
);

export interface ImproveActionParams {
    readonly sig: string;
    readonly action: "accept" | "reject" | "verdict";
    readonly force: boolean;
    readonly reason: string | undefined;
    readonly verdict: string;
}

export const decodeImproveActionParams = ({ path, body }: RouteInput): Decoded<ImproveActionParams> => {
    const sig = path.sig ?? "";
    if (!sig) return decodeFail("missing proposal sig", 400);
    const action = Option.getOrNull(decodeAction(path.action));
    if (action === null) return decodeFail("unknown_improve_action", 404);
    // Legacy: an unparseable/absent body is treated as {} (empty body ok).
    const record = body.kind === "json" && typeof body.value === "object" && body.value !== null
        ? (body.value as Record<string, unknown>)
        : {};
    return decodeOk({
        sig,
        action,
        force: record.force === true,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        verdict: typeof record.verdict === "string" ? record.verdict : "",
    });
};

/** Verbatim status->HTTP map from the legacy handleImproveAction. */
export const improveHttpStatus = (status: string): number =>
    status === "ok" ? 200
    : status === "not_found" ? 404
    : status === "wrong_status" || status === "scaffold_exists" || status === "verdict_locked" ? 409
    : status === "unsupported_form" || status === "missing_payload" || status === "invalid_verdict" ? 400
    : 500;

interface ImproveActionResult { readonly status: string; readonly message?: string }

export const improveRoutes: ReadonlyArray<AnyRoute> = [
    jsonRoute({
        method: "GET",
        path: "/api/next-actions",
        decode: () => decodeOk(undefined),
        handler: () => fetchNextActionsCached(),
    }),
    jsonRoute({
        method: "POST",
        path: "/api/improve/:sig/:action",
        readsBody: true,
        decode: decodeImproveActionParams,
        handler: (p: ImproveActionParams): Effect.Effect<ImproveActionResult, unknown, never> =>
            Effect.gen(function* () {
                const actions = yield* Effect.promise(() => import("../../../improve/actions.ts"));
                const result: ImproveActionResult = p.action === "accept"
                    ? yield* actions.acceptProposal({ sigOrId: p.sig, force: p.force })
                    : p.action === "reject"
                    ? yield* actions.rejectProposal({
                        sigOrId: p.sig,
                        ...(p.reason === undefined ? {} : { reason: p.reason }),
                    })
                    : yield* actions.setVerdict({ sigOrId: p.sig, verdict: p.verdict });
                // The action changes proposal/verdict cards - drop the cache so
                // the panel's refetch sees the new state immediately.
                yield* invalidateNextActionsCache();
                return result;
            }) as Effect.Effect<ImproveActionResult, unknown, never>,
        respond: (result) => jsonResponse(result, improveHttpStatus(result.status)),
    }),
];
