#!/usr/bin/env bun

const CLAUDE_DOCS_INDEX_URL = "https://code.claude.com/docs/llms.txt";
const CODEX_DOCS_INDEX_URL = "https://developers.openai.com/codex/llms.txt";

const CLAUDE_WATCHED_SLUGS = [
    "monitoring-usage",
    "claude-directory",
    "sessions",
    "settings",
    "env-vars",
    "hooks",
    "permissions",
    "mcp",
    "plugins",
    "skills",
    "sub-agents",
    "agent-sdk/observability",
    "agent-sdk/session-storage",
    "agent-sdk/todo-tracking",
    "agent-sdk/file-checkpointing",
    "agent-sdk/user-input",
] as const;

const CODEX_WATCHED_SLUGS = [
    "config-file/config-advanced",
    "agent-approvals-security",
    "sandboxing",
    "permissions",
    "hooks",
    "extend/mcp",
    "build-skills",
    "agent-configuration/rules",
    "plugins",
    "agent-configuration/subagents",
    "app-server",
    "codex-sdk",
    "github-action",
    "cloud",
] as const;

const CLAUDE_DOC_URL_RE = /\bhttps:\/\/code\.claude\.com\/docs\/en\/([A-Za-z0-9][A-Za-z0-9/_-]*?)\.md\b/g;
const CODEX_MARKDOWN_LINK_RE =
    /\[([^\]]+)\]\(https:\/\/learn\.chatgpt\.com\/docs\/([A-Za-z0-9][A-Za-z0-9/_-]*?)\.md(?:\?[^)#]*)?(?:#[^)]+)?\)/g;

export interface DocsEntry {
    readonly slug: string;
    readonly title: string;
}

interface ProviderSummary {
    readonly url: string;
    readonly total: number;
    readonly watched: number;
    readonly missingWatched: readonly string[];
    readonly error?: string;
}

interface DriftSummary {
    readonly claude: ProviderSummary;
    readonly codex: ProviderSummary;
}

function slugTitle(slug: string): string {
    return slug.split("/").at(-1) ?? slug;
}

function addEntry(entries: DocsEntry[], seen: Set<string>, slug: string, title: string): void {
    if (seen.has(slug)) return;
    seen.add(slug);
    entries.push({ slug, title });
}

export function parseClaudeDocsIndex(content: string): DocsEntry[] {
    const entries: DocsEntry[] = [];
    const seen = new Set<string>();
    const markdownLinkRe = /\[([^\]]+)\]\(https:\/\/code\.claude\.com\/docs\/en\/([A-Za-z0-9][A-Za-z0-9/_-]*?)\.md\)/g;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = markdownLinkRe.exec(content)) !== null) {
        addEntry(entries, seen, linkMatch[2] as string, linkMatch[1] as string);
    }
    let urlMatch: RegExpExecArray | null;
    while ((urlMatch = CLAUDE_DOC_URL_RE.exec(content)) !== null) {
        const slug = urlMatch[1] as string;
        addEntry(entries, seen, slug, slugTitle(slug));
    }
    return entries;
}

export function parseCodexDocsIndex(content: string): DocsEntry[] {
    const entries: DocsEntry[] = [];
    const seen = new Set<string>();
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = CODEX_MARKDOWN_LINK_RE.exec(content)) !== null) {
        addEntry(entries, seen, linkMatch[2] as string, linkMatch[1] as string);
    }
    return entries;
}

export function missingWatchedSlugs(entries: readonly DocsEntry[], watchedSlugs: readonly string[]): string[] {
    const available = new Set(entries.map((entry) => entry.slug));
    return watchedSlugs.filter((slug) => !available.has(slug));
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
}

async function summarizeProvider(
    url: string,
    watchedSlugs: readonly string[],
    parse: (content: string) => DocsEntry[],
): Promise<ProviderSummary> {
    try {
        const entries = parse(await fetchText(url));
        return {
            url,
            total: entries.length,
            watched: watchedSlugs.length,
            missingWatched: missingWatchedSlugs(entries, watchedSlugs),
        };
    } catch (error) {
        return {
            url,
            total: 0,
            watched: watchedSlugs.length,
            missingWatched: [...watchedSlugs],
            error: errorText(error),
        };
    }
}

async function main(): Promise<void> {
    const [claude, codex] = await Promise.all([
        summarizeProvider(CLAUDE_DOCS_INDEX_URL, CLAUDE_WATCHED_SLUGS, parseClaudeDocsIndex),
        summarizeProvider(CODEX_DOCS_INDEX_URL, CODEX_WATCHED_SLUGS, parseCodexDocsIndex),
    ]);

    const summary: DriftSummary = { claude, codex };
    console.log(JSON.stringify(summary, null, 2));

    const failed =
        claude.total === 0 ||
        codex.total === 0 ||
        claude.missingWatched.length > 0 ||
        codex.missingWatched.length > 0 ||
        claude.error !== undefined ||
        codex.error !== undefined;

    if (failed) process.exit(1);
}

if (import.meta.main) {
    await main();
}
