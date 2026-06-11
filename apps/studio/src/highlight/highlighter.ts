/**
 * Tokenizer for inline transcript highlighting, backed by @pierre/diffs'
 * shared shiki highlighter - the same instance the diff/file tool cards use,
 * so grammars and themes load once and both surfaces stay on one engine.
 * Still a lazy chunk behind HighlightedCode's dynamic import, so routes that
 * never render code don't pay for it. All ids passed in must already be
 * canonical (see lang.ts resolveLang) - they key shiki's bundledLanguages.
 */
import { getSharedHighlighter, type DiffsHighlighter, type ThemedToken } from "@pierre/diffs";

export type { DiffsHighlighter, ThemedToken };

/** light = transcript surfaces (white/panel bg); dark = terminal output
 *  blocks. catppuccin-mocha's editor background is #1e1e2e - exactly the
 *  studio's --term-bg - so dark tokens sit on the block's own color. */
export type HighlightTheme = "light" | "dark";
const THEME_NAME: Record<HighlightTheme, string> = {
    light: "github-light",
    dark: "catppuccin-mocha",
};

/** Themed token lines for `code`, or null when the grammar is unavailable. */
export async function tokenize(
    code: string,
    lang: string,
    theme: HighlightTheme = "light",
): Promise<ThemedToken[][] | null> {
    try {
        const themeName = THEME_NAME[theme];
        const highlighter = await getSharedHighlighter({ themes: [themeName], langs: [lang] });
        return highlighter.codeToTokens(code, { lang, theme: themeName }).tokens;
    } catch {
        // Unknown grammar or failed chunk load degrades to plain text; the
        // resolver doesn't cache rejections, so a later attempt can retry.
        return null;
    }
}

/** Langs shiki tokenizes without a grammar - always available. */
const PLAIN_LANGS = new Set(["text", "plaintext", "txt", "ansi"]);

/** Theme id for consumers that pass a theme name alongside the shared
 *  highlighter (shiki-magic-move). Matches the light transcript surfaces. */
export const THEME = THEME_NAME.light;

/** The shared highlighter with `lang` + the light theme loaded, for consumers
 *  that drive shiki directly (shiki-magic-move). null when the grammar is
 *  unavailable. */
export async function highlighterFor(lang: string): Promise<DiffsHighlighter | null> {
    try {
        return await getSharedHighlighter({
            themes: [THEME],
            langs: PLAIN_LANGS.has(lang) ? [] : [lang],
        });
    } catch {
        return null;
    }
}
