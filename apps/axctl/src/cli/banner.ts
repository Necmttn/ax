/**
 * Brand banner shown by `axctl version`, `axctl install`, `axctl studio`,
 * and other first-touch surfaces. Restraint is on-brand - typography,
 * not ASCII art. See docs/brand.md for the wordmark + tag rules.
 *
 * Studio deeplink resolution also lives here (`resolveStudioTarget`,
 * `probeStudioPort`). Studio ephemeral (wave 3, `c-daemon-studio`) retired
 * the always-on `ax serve` daemon and its pidfile
 * (`dashboard/serve-instance.ts`, deleted) - `ax studio` now binds a port
 * only while a client is connected. There is nothing left to read a pidfile
 * FROM, so `resolveStudioTarget` (used by session-output deeplinks in
 * `ax recall` / `ax sessions ...` / MCP tools - latency-sensitive, no network
 * probe allowed) can no longer answer "is it live" at all; it always names
 * the default port and `live: false`. `probeStudioPort`, used only at
 * `ax studio` startup (not latency-sensitive - a human is about to wait on a
 * server boot anyway), still does a real network check so a second
 * `ax studio` invocation on the same port prints the first one's URL instead
 * of an EADDRINUSE stack trace.
 */
import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";

const HRULE = "━".repeat(50);

export const BANNER = `
  ax  agent experience layer
  ${HRULE}
  observability + memory for AI coding agents
`;

export const BANNER_COMPACT = `  ax · agent experience layer`;

/** Small terminal-friendly ASCII wordmark for `ax studio`. Two-line, tight. */
export const WORDMARK_ASCII = `
  █▀█ ▀▄▀
  █▀█ █ █  agent experience layer
`;

/**
 * Landing banner printed when `axctl` is run with no command. Wordmark art +
 * tagline + a nudge to `--help`. ANSI dim is used so the art reads as chrome,
 * not noise; stripped automatically when stdout is not a TTY.
 */
export function formatLandingBanner(version: string, color: boolean): string {
    const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
    const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
    return [
        "",
        bold("  █▀█ ▀▄▀"),
        `${bold("  █▀█ █ █")}  ${dim(`agent experience layer · v${version}`)}`,
        "",
        "  observability + memory for AI coding agents",
        "",
        `  ${dim("run")} ax --help ${dim("to see commands, or")} ax setup ${dim("to get started")}`,
        "",
    ].join("\n");
}

/**
 * Banner printed on `axctl studio` startup. Surrealist-style: wordmark +
 * the local studio URL. Studio serves itself same-origin, so opening this
 * URL just works - no cross-origin handshake to a loopback process (the bug
 * the hosted https studio kept hitting).
 */
export function formatStudioBanner(port: number): string {
    return [
        WORDMARK_ASCII,
        `  studio + api      ${serveStudioUrl(port)}`,
        "",
    ].join("\n");
}

/**
 * Local studio URL. Kept as `serveStudioUrl` (not renamed with the rest of
 * the "serve" -> "studio" vocabulary): CLAUDE.md names this exact function as
 * the single source of the deeplink base, and callers across the CLI import
 * it by this name - renaming it would be a purely cosmetic diff across files
 * this chunk does not own.
 */
export function serveStudioUrl(port: number): string {
    return `http://localhost:${port}/`;
}

/**
 * Printed when `ax studio` finds another instance already answering on the
 * port (a genuine race - two invocations, one binds first). The goal ("open
 * the dashboard") is already achievable, so this leads with the URL, not the
 * failure. No pid: studio ephemeral keeps no pidfile to resolve one from.
 */
export function formatStudioAlreadyRunning(
    port: number,
    info: { readonly version: string },
): string {
    return [
        `[ax] ax studio is already running on port ${port} (v${info.version})`,
        `  studio + api      ${serveStudioUrl(port)}`,
        "",
    ].join("\n");
}

/** Printed when the port is held by something that is not ax studio. */
export function formatStudioPortBusy(port: number): string {
    return [
        `[ax] port ${port} is in use by another process (not ax studio).`,
        `  see who holds it  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
        `  or pick a port    ax studio --port=${port + 1}`,
    ].join("\n");
}

/** Where Studio deeplinks point. */
export interface StudioTarget {
    /** `http://localhost:<port>` - no trailing slash. */
    readonly baseUrl: string;
    readonly port: number;
    /** Always `false`: studio ephemeral keeps no persistent record of a
     *  running instance, and a network probe is banned here (latency - see
     *  the module doc). Kept as a field (not dropped) so `StudioDeeplink`
     *  consumers (nav/next-links.ts) don't need a shape change. */
    readonly live: boolean;
}

/**
 * Resolve the Studio base URL for deeplinks in session-oriented output
 * (`ax recall`, `ax sessions ...`, MCP tools). The route is stable regardless
 * of whether a studio happens to be running right now, so this always names
 * the default port; the link copy (nav/next-links.ts) tells the reader to
 * run `ax studio` rather than claiming it is already open.
 */
export async function resolveStudioTarget(): Promise<StudioTarget> {
    return {
        baseUrl: `http://localhost:${DEFAULT_DASHBOARD_PORT}`,
        port: DEFAULT_DASHBOARD_PORT,
        live: false,
    };
}

export type StudioProbe =
    | { readonly kind: "ax"; readonly version: string }
    | { readonly kind: "foreign" }
    | { readonly kind: "none" };

/**
 * Ask whoever holds `port` to identify itself, at `ax studio` STARTUP only
 * (a human is about to wait on a server boot regardless, so the round trip
 * this spends is not the latency-sensitive case `resolveStudioTarget` guards
 * against). An ax instance answers `/api/version` with `{ version, ... }`;
 * any other HTTP listener is "foreign"; no/hung response is "none" (closed
 * port, or a non-HTTP listener - `Bun.serve`'s EADDRINUSE path catches that).
 */
export async function probeStudioPort(
    port: number,
    timeoutMs = 1500,
): Promise<StudioProbe> {
    let res: Response;
    try {
        res = await fetch(`http://127.0.0.1:${port}/api/version`, {
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        return { kind: "none" };
    }
    if (!res.ok) return { kind: "foreign" };
    const body: unknown = await res.json().catch(() => null);
    if (
        typeof body === "object" && body !== null && !Array.isArray(body) &&
        typeof (body as Record<string, unknown>).version === "string" &&
        "api_version" in body
    ) {
        return { kind: "ax", version: (body as Record<string, unknown>).version as string };
    }
    return { kind: "foreign" };
}
