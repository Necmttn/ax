/**
 * Lazy Shiki singleton. Fine-grained core + JS regex engine (no wasm), one
 * light theme; grammars dynamic-imported on first use so Vite splits each
 * into its own chunk and the base bundle stays small. All ids passed in must
 * already be canonical (see lang.ts resolveLang) - they key LANG_LOADERS.
 */
import { createHighlighterCore, type HighlighterCore, type LanguageInput, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export type { ThemedToken };

/** light = transcript surfaces (white/panel bg); dark = terminal output
 *  blocks. catppuccin-mocha's editor background is #1e1e2e - exactly the
 *  studio's --term-bg - so dark tokens sit on the block's own color. */
export type HighlightTheme = "light" | "dark";
const THEME_NAME: Record<HighlightTheme, string> = {
    light: "github-light",
    dark: "catppuccin-mocha",
};

const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
    typescript: () => import("@shikijs/langs/typescript"),
    tsx: () => import("@shikijs/langs/tsx"),
    javascript: () => import("@shikijs/langs/javascript"),
    jsx: () => import("@shikijs/langs/jsx"),
    json: () => import("@shikijs/langs/json"),
    jsonc: () => import("@shikijs/langs/jsonc"),
    shellscript: () => import("@shikijs/langs/shellscript"),
    python: () => import("@shikijs/langs/python"),
    sql: () => import("@shikijs/langs/sql"),
    markdown: () => import("@shikijs/langs/markdown"),
    yaml: () => import("@shikijs/langs/yaml"),
    rust: () => import("@shikijs/langs/rust"),
    go: () => import("@shikijs/langs/go"),
    css: () => import("@shikijs/langs/css"),
    html: () => import("@shikijs/langs/html"),
    diff: () => import("@shikijs/langs/diff"),
    toml: () => import("@shikijs/langs/toml"),
    dockerfile: () => import("@shikijs/langs/dockerfile"),
};

let corePromise: Promise<HighlighterCore> | null = null;

function getCore(): Promise<HighlighterCore> {
    corePromise ??= createHighlighterCore({
        themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/catppuccin-mocha")],
        langs: [],
        engine: createJavaScriptRegexEngine(),
    });
    return corePromise;
}

const langReady = new Map<string, Promise<boolean>>();

function ensureLang(lang: string): Promise<boolean> {
    const pending = langReady.get(lang);
    if (pending) return pending;
    const loader = LANG_LOADERS[lang];
    const ready = loader
        ? getCore()
            .then((core) => core.loadLanguage(loader() as LanguageInput))
            .then(() => true)
            // A failed grammar chunk load degrades to plain text; clear the
            // memo so a later attempt can retry.
            .catch(() => {
                langReady.delete(lang);
                return false;
            })
        : Promise.resolve(false);
    langReady.set(lang, ready);
    return ready;
}

/** Themed token lines for `code`, or null when the grammar is unavailable. */
export async function tokenize(
    code: string,
    lang: string,
    theme: HighlightTheme = "light",
): Promise<ThemedToken[][] | null> {
    if (!(await ensureLang(lang))) return null;
    const core = await getCore();
    return core.codeToTokens(code, { lang, theme: THEME_NAME[theme] }).tokens;
}
