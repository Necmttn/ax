/**
 * Studio-side client for the Insights Surface Contract
 * (@ax/lib/shared/api-contract): `HttpApiClient` derived from the same
 * HttpApi the daemon serves, so paths, params, and response types cannot
 * drift between the two codebases.
 *
 * This module owns ONLY the contract -> Promise bridge. The studio-specific
 * transport behaviors stay where they were:
 *   - mock-fixtures interception happens in api.ts BEFORE calling here
 *     (mock mode without a connected endpoint never reaches the network),
 *   - the daemon endpoint (localStorage `?endpoint=` connect flow) arrives
 *     as `baseUrl`, re-resolved per call because the user can connect or
 *     disconnect at runtime,
 *   - failures are normalized to `ApiError` with an HTTP status (0 = network
 *     or decode failure), preserving the status-branching the UI relies on.
 */
import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { AxApi } from "@ax/lib/shared/api-contract";
import { ApiError } from "./api-error.ts";

/** One browser-lifetime runtime over the fetch-backed HttpClient. */
const runtime = ManagedRuntime.make(FetchHttpClient.layer);

const makeClient = (baseUrl: string | null) =>
    HttpApiClient.make(AxApi, baseUrl === null ? {} : { baseUrl });

type AxClient = Effect.Success<ReturnType<typeof makeClient>>;

/** Map a squashed client failure to the ApiError contract the UI branches on. */
function toApiError(err: unknown): ApiError {
    const status =
        typeof err === "object" && err !== null && "response" in err &&
        typeof (err as { response?: { status?: unknown } }).response?.status === "number"
            ? (err as { response: { status: number } }).response.status
            : 0;
    const message = err instanceof Error ? err.message : String(err);
    return new ApiError(message, status);
}

/**
 * Run one contract call: build the per-call client against `baseUrl`
 * (null = same-origin relative URLs) and normalize failures to ApiError.
 */
async function runContract<A, E>(
    baseUrl: string | null,
    call: (client: AxClient) => Effect.Effect<A, E>,
): Promise<A> {
    const exit = await runtime.runPromiseExit(
        Effect.flatMap(makeClient(baseUrl), call),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    throw toApiError(Cause.squash(exit.cause));
}

// ---------------------------------------------------------------- calls

/** GET /api/version through the contract. */
export const contractVersion = (baseUrl: string | null) =>
    runContract(baseUrl, (client) => client.system.version());
