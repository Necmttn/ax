/**
 * NavLink - "HATEOAS for LLMs".
 *
 * Instead of teaching the whole tool/CLI grammar upfront in descriptions,
 * responses carry `next` links that describe valid follow-up actions with
 * ready-to-run payloads. An agent copies `call.arguments` verbatim into the
 * named MCP tool, runs `cmd` as-is in a shell, or opens `url` in a browser.
 * Three transports because ax is driven multiple ways: MCP tool calls,
 * CLI/Bash, and (for Studio deeplinks) a browser. Some affordances (e.g. the
 * harness resume command) only exist as shell commands; others (an "open this
 * session in Studio" deeplink) only exist as a URL.
 */

/** An MCP follow-up call. Copy `arguments` verbatim - do not edit. */
export interface NavLinkCall {
	/** Tool name to invoke. */
	readonly tool: string;
	/** Arguments object to pass. Copy verbatim. */
	readonly arguments: Record<string, unknown>;
}

/**
 * A ready-to-run follow-up action. At least one of `call` / `cmd` / `url` is
 * set. `call` = MCP follow-up; `cmd` = literal shell command (copy-paste
 * as-is); `url` = a deeplink to open in a browser (e.g. an ax Studio session
 * route), which an agent can surface to the user verbatim.
 */
export interface NavLink {
	/** Human/LLM-readable hint for when to use this link. */
	readonly description: string;
	readonly call?: NavLinkCall;
	readonly cmd?: string;
	/**
	 * A deeplink URL to open in a browser - e.g. an ax Studio session route.
	 * The CLI footer renders it as the actionable payload when no `cmd` is set.
	 */
	readonly url?: string;
	readonly ui?: {
		/** Higher sorts first. */
		readonly priority?: number;
		/** Grouping hint, e.g. "resume" | "read" | "search" | "navigate". */
		readonly group?: string;
	};
}

/** A payload extended with navigation links. */
export type WithNext<T> = T & { readonly next?: ReadonlyArray<NavLink> };

/** Sort links by `ui.priority` descending (missing priority = 0). */
export const sortNavLinks = (
	links: ReadonlyArray<NavLink>,
): ReadonlyArray<NavLink> =>
	[...links].sort((a, b) => (b.ui?.priority ?? 0) - (a.ui?.priority ?? 0));
