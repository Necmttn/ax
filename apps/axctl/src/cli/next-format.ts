/**
 * CLI rendering for NavLinks - the `next:` footer.
 *
 * Text output shows `cmd` links only (a terminal user can't paste an MCP
 * call); priority-sorted, capped at 4, with the description as a dim ANSI
 * comment after the command - matching the inline-ANSI convention used by
 * cmdRecall / formatSessionsTable. `--json` output carries the full NavLink
 * objects instead, so agents driving the CLI get both transports.
 */
import type { NavLink } from "@ax/lib/shared/nav-link";
import { sortNavLinks } from "@ax/lib/shared/nav-link";

const MAX_FOOTER_LINKS = 4;
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Render the `next:` footer. Returns "" when no link has a `cmd` - callers
 * can append unconditionally.
 */
export const renderNextFooter = (
    links: ReadonlyArray<NavLink>,
): string => {
    const cmds = sortNavLinks(links)
        .filter((l): l is NavLink & { cmd: string } => typeof l.cmd === "string")
        .slice(0, MAX_FOOTER_LINKS);
    if (cmds.length === 0) return "";

    const width = Math.max(...cmds.map((l) => l.cmd.length));
    const lines = cmds.map(
        (l) => `  ${l.cmd.padEnd(width)}   ${DIM}# ${l.description}${RESET}`,
    );
    return `\nnext:\n${lines.join("\n")}`;
};

/**
 * Print the `next:` footer to STDERR.
 *
 * stderr, not stdout, deliberately: agents reflexively pipe text output
 * through `| head -N`, and a stdout footer printed last gets decapitated
 * (observed in 9/10 calls of the v0.21.0 dogfood retro). On a TTY both
 * streams hit the terminal in order so the rendering is identical; under a
 * pipe the footer stays visible on the terminal instead of vanishing into
 * the truncated pipe. JSON paths are unaffected - they carry structured
 * `next` on stdout.
 */
export const printNextFooter = (links: ReadonlyArray<NavLink>): void => {
    const footer = renderNextFooter(links);
    if (footer) process.stderr.write(`${footer}\n`);
};
