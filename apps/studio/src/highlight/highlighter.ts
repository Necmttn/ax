/**
 * Tokenizer for inline transcript highlighting, backed by @pierre/diffs'
 * shared shiki highlighter - the same instance the diff/file tool cards use,
 * so grammars and themes load once and both surfaces stay on one engine.
 * Still a lazy chunk behind HighlightedCode's dynamic import, so routes that
 * never render code don't pay for it. All ids passed in must already be
 * canonical (see lang.ts resolveLang) - they key shiki's bundledLanguages.
 */
import { getSharedHighlighter, type ThemedToken } from "@pierre/diffs";

export type { ThemedToken };

export const THEME = "github-light";

/** Themed token lines for `code`, or null when the grammar is unavailable. */
export async function tokenize(code: string, lang: string): Promise<ThemedToken[][] | null> {
    try {
        const highlighter = await getSharedHighlighter({ themes: [THEME], langs: [lang] });
        return highlighter.codeToTokens(code, { lang, theme: THEME }).tokens;
    } catch {
        // Unknown grammar or failed chunk load degrades to plain text; the
        // resolver doesn't cache rejections, so a later attempt can retry.
        return null;
    }
}
