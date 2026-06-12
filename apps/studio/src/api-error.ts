/**
 * Fetch error that carries the HTTP status so callers can branch on it
 * (e.g. 503 from POST /api/ingest = Durable Streams sidecar unavailable on
 * the compiled binary -> engage the polling fallback). Lives in its own
 * module so both the legacy jsonFetch transport (api.ts) and the contract
 * client (contract-client.ts) can throw it without an import cycle.
 */
export class ApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = "ApiError";
    }
}
