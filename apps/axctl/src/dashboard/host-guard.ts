// Shared loopback Host-header guard. Both the dashboard server and the DB-free
// OTLP spool server bind a loopback port; a DNS-rebinding page re-points its own
// domain at 127.0.0.1 and issues "same-origin" requests that sail past CORS, but
// it cannot forge the Host header (the browser always sends its own domain). So
// a PRESENT, non-loopback Host is rejected; a MISSING Host (curl, unit tests,
// non-browser exporters) is allowed - a browser can never produce that.
//
// Kept in its own dep-free module so the lean spool server can import it without
// pulling in the whole serve runtime (router, durable streams, Effect runtime).

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True when the Host header names the loopback interface (optional :port), or
 *  is absent/empty. */
export function isAllowedHost(host: string | null): boolean {
    if (host === null || host === "") return true;
    const hostname = host.startsWith("[")
        ? host.slice(0, host.indexOf("]") + 1) // strip :port after ]
        : host.split(":")[0]!;
    return LOOPBACK_HOSTS.has(hostname);
}
