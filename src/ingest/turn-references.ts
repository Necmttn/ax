export interface TurnReferences {
    readonly files: readonly string[];
    readonly symbols: readonly string[];
    readonly errors: readonly string[];
}

const FILE_RE = /\b(?:\.{1,2}\/|\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|surql|sql|md|mdx|json|jsonl|yaml|yml|toml|css|scss|html|py|rs|go|java|kt|swift|rb|php|sh|bash|zsh)\b/g;
const SYMBOL_CAMEL_RE = /\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]+)+\b/g;
const SYMBOL_SNAKE_RE = /\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g;
const FUNCTION_RE = /\b[$A-Za-z_][$\w]{2,}\s*\(/g;
const QUOTED_RE = /"([^"\n]{4,180})"|'([^'\n]{4,180})'|`([^`\n]{4,180})`/g;
const ERROR_LINE_RE = /\b(?:Error|Exception|TypeError|ReferenceError|SyntaxError|DbError|SqlError|Panic):?\s+([^\n.;]{4,180})/g;

const SYMBOL_STOP = new Set([
    "Error",
    "Exception",
    "TypeError",
    "ReferenceError",
    "SyntaxError",
    "DbError",
    "SqlError",
    "JSON",
    "HTTP",
    "URL",
    "API",
    "TODO",
]);

function uniqueSorted(values: Iterable<string>): string[] {
    return Array.from(new Set(Array.from(values).map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
    );
}

function cleanPath(path: string): string {
    return path.replace(/^[`'"]+|[`'",;:)]+$/g, "").replace(/^\.\//, "");
}

function looksLikeErrorText(value: string): boolean {
    return /\b(?:error|exception|failed|missing|not found|not initialized|cannot|undefined|null|denied|invalid|timeout)\b/i
        .test(value);
}

export function normalizeErrorSignature(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/0x[a-f0-9]+/g, "<hex>")
        .replace(/\b\d+\b/g, "<num>")
        .replace(/\s+/g, " ")
        .slice(0, 220);
}

export function classifySymbolKind(symbol: string): string {
    if (symbol.includes("_")) return "snake";
    if (/^[A-Z]/.test(symbol)) return "camel";
    return "function";
}

export function extractTurnReferences(text: string): TurnReferences {
    const files = uniqueSorted((text.match(FILE_RE) ?? []).map(cleanPath)).slice(0, 32);

    const symbols = uniqueSorted([
        ...(text.match(SYMBOL_CAMEL_RE) ?? []),
        ...(text.match(SYMBOL_SNAKE_RE) ?? []),
        ...(text.match(FUNCTION_RE) ?? []).map((match) => match.replace(/\s*\($/, "")),
    ].filter((symbol) => symbol.length >= 4 && symbol.length <= 80 && !SYMBOL_STOP.has(symbol))).slice(0, 32);

    const quoted = Array.from(text.matchAll(QUOTED_RE))
        .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
        .filter((value) => value.length >= 4 && looksLikeErrorText(value));
    const errorLines = Array.from(text.matchAll(ERROR_LINE_RE))
        .map((match) => match[0] ?? "")
        .filter(Boolean);
    const errors = uniqueSorted([...quoted, ...errorLines]).slice(0, 16);

    return { files, symbols, errors };
}
