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
 * Print the `next:` block to STDOUT, intended to be called BEFORE the data.
 *
 * Placement history (two dogfood retros):
 *   v0.21.0 - footer at the bottom of stdout: decapitated by `| head -N`
 *     in 9/10 agent calls.
 *   v0.22.0 - footer on stderr: defeated anyway, because agents reflexively
 *     write `2>&1 | head`, which folds stderr back into stdout upstream of
 *     `head`.
 * Conclusion: placement beats stream routing. The block prints FIRST, so any
 * `head` keeps it and agents read it before the data. JSON paths are
 * unaffected - they carry structured `next` on stdout.
 */
export const printNextLinks = (links: ReadonlyArray<NavLink>): void => {
    const block = renderNextFooter(links);
    if (block) process.stdout.write(`${block.replace(/^\n/, "")}\n\n`);
};
