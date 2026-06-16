/**
 * Brand banner shown by `axctl version`, `axctl install`, `axctl serve`,
 * and other first-touch surfaces. Restraint is on-brand - typography,
 * not ASCII art. See docs/brand.md for the wordmark + tag rules.
 */

const HRULE = "━".repeat(50);

export const BANNER = `
  ax  agent experience layer
  ${HRULE}
  observability + memory for AI coding agents
`;

export const BANNER_COMPACT = `  ax · agent experience layer`;

/** Small terminal-friendly ASCII wordmark for `ax serve`. Two-line, tight. */
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
 * Banner printed on `axctl serve` startup. Surrealist-style: wordmark +
 * the local studio URL. Studio is served by the daemon itself, same-origin,
 * so opening this URL just works - no cross-origin handshake to a loopback
 * daemon (the bug the hosted https studio kept hitting).
 */
export function formatServeBanner(port: number): string {
    return [
        WORDMARK_ASCII,
        `  studio + api      ${serveStudioUrl(port)}`,
        "",
    ].join("\n");
}

/** Local studio URL - the daemon serves the studio SPA at its own root. */
export function serveStudioUrl(port: number): string {
    return `http://localhost:${port}/`;
}

/**
 * Printed when `ax serve` finds an ax daemon already answering on the port.
 * The goal ("open the dashboard") is already achievable, so this leads with
 * the URLs, not the failure.
 */
export function formatServeAlreadyRunning(
    port: number,
    info: { readonly version: string; readonly pid: number | null },
): string {
    const pid = info.pid === null
        ? "pid unknown - find it: lsof -nP -iTCP:" + port + " -sTCP:LISTEN"
        : `pid ${info.pid}`;
    return [
        `[ax] ax serve is already running on port ${port} (${pid}, v${info.version})`,
        `  studio + api      ${serveStudioUrl(port)}`,
        "",
        "  manage it:        ax serve status · ax serve stop",
    ].join("\n");
}

/** Printed when the port is held by something that is not an ax daemon. */
export function formatServePortBusy(port: number): string {
    return [
        `[ax] port ${port} is in use by another process (not ax serve).`,
        `  see who holds it  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
        `  or pick a port    ax serve --port=${port + 1}`,
    ].join("\n");
}
