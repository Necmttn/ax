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

const STUDIO_BASE = "https://ax.necmttn.com/studio/";

/**
 * Banner printed on `axctl serve` startup. Surrealist-style: wordmark +
 * the local daemon URL + a deep link to the public studio that auto-connects
 * to this daemon.
 */
export function formatServeBanner(port: number): string {
    const localUrl = `http://localhost:${port}`;
    const localIp = `http://127.0.0.1:${port}`;
    const studioUrl = `${STUDIO_BASE}?endpoint=${encodeURIComponent(localIp)}`;
    return [
        WORDMARK_ASCII,
        `  local daemon      ${localUrl}`,
        `  open in studio    ${studioUrl}`,
        "",
    ].join("\n");
}
