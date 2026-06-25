/**
 * Hooks family: POST /hooks/eval - the daemon fast-path for SDK hooks.
 *
 * A hook shim POSTs the raw harness event JSON (the same payload it received on
 * stdin, plus a forwarded `_ax_env` allowlist) and gets back the merged
 * ProcessOutcome ({ exitCode, stdout?, stderr? }) - evaluated WARM in the
 * already-running daemon via `dispatchEvent`, skipping the cold `bun` spawn +
 * effect-bundle parse the spawned path pays per fire. DB-free (the dispatcher
 * only needs GitEnvLive), so it works on both source and the compiled binary,
 * and answers even when SurrealDB is down.
 *
 * Fail-open by construction: a body read error -> allow; `dispatchEvent` never
 * throws (per-guard defects already fail open). A daemon hiccup must never wedge
 * the agent, so the shim also treats any non-2xx / unreachable daemon as
 * "fall back to the local bundle".
 */
import { Effect } from "effect";
import { dispatchEvent } from "@ax/hooks-sdk/dispatch";
import { GitEnvLive } from "@ax/hooks-sdk/git-env";
import { jsonResponse, rawRoute, type AnyRoute } from "../router.ts";

export const hooksRoutes: ReadonlyArray<AnyRoute> = [
    rawRoute({
        method: "POST",
        path: "/hooks/eval",
        handler: async (input) => {
            let bodyText = "";
            try {
                bodyText = await input.req.text();
            } catch {
                // Unreadable body -> empty event -> no guard matches -> allow.
            }
            const outcome = await Effect.runPromise(
                dispatchEvent(bodyText, process.env as Record<string, string | undefined>).pipe(
                    Effect.provide(GitEnvLive),
                ),
            );
            return jsonResponse(outcome);
        },
    }),
];
