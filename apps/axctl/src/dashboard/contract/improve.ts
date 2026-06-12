/**
 * Handlers for the improve group (experiment loop) of the Insights
 * Surface Contract. The action handler keeps the legacy status->HTTP map
 * (improveHttpStatus in router/routes/improve.ts): ok -> 200 with the
 * result body; every other status becomes the matching error class with
 * `{ error }` carrying the action's message (the legacy wire shape put
 * the whole result in the non-200 body, but the studio's transport threw
 * away everything except the status, so `{ error: message }` is strictly
 * more informative).
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
    AxApi,
    BadRequestError,
    ConflictError,
    InternalError,
    NotFoundError,
} from "@ax/lib/shared/api-contract";
import { fetchImproveProposals } from "../improve-proposals.ts";
import { asJsonValue, internal, orInternal } from "./common.ts";

interface ImproveActionResult { readonly status: string; readonly message?: string }

/** Legacy improveHttpStatus parity, expressed as contract error classes. */
const toActionFailure = (result: ImproveActionResult) => {
    const error = result.message ?? result.status;
    switch (result.status) {
        case "not_found":
            return new NotFoundError({ error });
        case "wrong_status":
        case "scaffold_exists":
        case "verdict_locked":
            return new ConflictError({ error });
        case "unsupported_form":
        case "missing_payload":
        case "invalid_verdict":
            return new BadRequestError({ error });
        default:
            return new InternalError({ error });
    }
};

export const ImproveGroupLive = HttpApiBuilder.group(AxApi, "improve", (handlers) =>
    handlers
        .handle("improveList", () =>
            // asJsonValue: proposal rows carry SurrealDB RecordId instances,
            // which Schema.Unknown's encode rejects - see common.ts.
            orInternal(fetchImproveProposals().pipe(
                Effect.map((proposals) => asJsonValue({ proposals })),
            )))
        .handle("improveAction", ({ params, payload }) =>
            Effect.gen(function* () {
                // Dynamic import preserved from the legacy handler: the CLI and
                // HTTP paths share src/improve/actions.ts semantics.
                const actions = yield* Effect.promise(() => import("../../improve/actions.ts"));
                const run = params.action === "accept"
                    ? actions.acceptProposal({ sigOrId: params.sig, force: payload.force === true })
                    : params.action === "reject"
                    ? actions.rejectProposal({
                        sigOrId: params.sig,
                        ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
                    })
                    : actions.setVerdict({ sigOrId: params.sig, verdict: payload.verdict ?? "" });
                const result = (yield* run.pipe(Effect.mapError(internal))) as ImproveActionResult;
                if (result.status !== "ok") return yield* Effect.fail(toActionFailure(result));
                return result;
            })));
