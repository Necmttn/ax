const REPO_RAW = "https://raw.githubusercontent.com/Necmttn/ax/main";
const REPO_API = "https://api.github.com/repos/Necmttn/ax";

export const COMMUNITY_PATTERN_TREE_URL = `${REPO_API}/git/trees/main?recursive=1`;

export const PATTERN_CATEGORIES = [
    "design-aesthetic",
    "problem-solving-strategy",
    "debugging",
    "failure-mode",
    "workflow",
    "tool-output-mix",
    "stack-choice",
] as const;

export type PatternCategory = (typeof PATTERN_CATEGORIES)[number];

export const PATTERN_CATEGORY_LABELS = {
    "design-aesthetic": "Design aesthetic",
    "problem-solving-strategy": "Problem-solving strategy",
    debugging: "Debugging",
    "failure-mode": "Failure mode",
    workflow: "Workflow",
    "tool-output-mix": "Tool/output mix",
    "stack-choice": "Stack choice",
} satisfies Record<PatternCategory, string>;

export type PatternLinkRel = "recovered-by" | "pairs-with" | "conflicts-with";
export type PatternTrend = "rising" | "stable" | "falling" | "stale";

export interface CommunityPatternEvidence {
    readonly sessions: number;
    readonly confidence: number;
    readonly last_reinforced?: string;
    readonly trend?: PatternTrend;
}

export interface CommunityPatternLink {
    readonly rel: PatternLinkRel;
    readonly ref: string;
}

export interface CommunityPatternAuthor {
    readonly login: string;
}

interface CommunityPatternBase {
    readonly key: string;
    readonly category: PatternCategory;
    readonly name: string;
    readonly evidence: CommunityPatternEvidence;
    readonly links?: readonly CommunityPatternLink[];
    readonly author?: CommunityPatternAuthor;
}

export type ProsePatternCategory = Exclude<PatternCategory, "stack-choice">;

export type CommunityPattern =
    | (CommunityPatternBase & {
        readonly category: ProsePatternCategory;
        readonly summary: string;
    })
    | (CommunityPatternBase & {
        readonly category: "stack-choice";
        readonly slot: string;
        readonly over?: readonly string[];
        readonly context?: string;
    });

export interface CommunityPatternDrop {
    readonly path: string;
    readonly reason: string;
}

export interface CommunityPatternsResult {
    readonly patterns: readonly CommunityPattern[];
    readonly dropped: readonly CommunityPatternDrop[];
}

export interface PatternCategoryGroup {
    readonly category: PatternCategory;
    readonly label: string;
    readonly count: number;
    readonly patterns: readonly CommunityPattern[];
}

const CATEGORY_SET = new Set<string>(PATTERN_CATEGORIES);
const PROSE_CATEGORY_SET = new Set<string>(PATTERN_CATEGORIES.filter((c) => c !== "stack-choice"));
const LINK_REL_SET = new Set<string>(["recovered-by", "pairs-with", "conflicts-with"]);
const TREND_SET = new Set<string>(["rising", "stable", "falling", "stale"]);

const PATTERN_FILE_RE = /^community\/patterns\/([a-z0-9-]+)\/([a-z0-9-]+)\.json$/;
const PATTERN_REF_RE = /^([a-z0-9-]+)\/([a-z0-9-]+)$/;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown, what: string): string => {
    if (typeof value !== "string") throw new Error(`invalid ${what}`);
    return value;
};

const optionalStr = (value: unknown, what: string): string | undefined => {
    if (value === undefined) return undefined;
    return str(value, what);
};

const finiteNumber = (value: unknown, what: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid ${what}`);
    if (value < 0) throw new Error(`invalid ${what}`);
    return value;
};

const maybeStringArray = (value: unknown, what: string): readonly string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`invalid ${what}`);
    return value;
};

function parsePatternPath(path: string): { category: PatternCategory; name: string } | null {
    const match = PATTERN_FILE_RE.exec(path);
    if (match === null) return null;
    const category = match[1];
    const name = match[2];
    if (category === undefined || name === undefined || !CATEGORY_SET.has(category)) return null;
    return { category: category as PatternCategory, name };
}

function patternCategoryOrder(category: PatternCategory): number {
    return PATTERN_CATEGORIES.indexOf(category);
}

function sortPatterns(patterns: readonly CommunityPattern[]): CommunityPattern[] {
    return [...patterns].sort((a, b) =>
        patternCategoryOrder(a.category) - patternCategoryOrder(b.category)
        || a.name.localeCompare(b.name)
    );
}

function validatePatternRef(ref: string): string {
    const match = PATTERN_REF_RE.exec(ref);
    if (match === null) throw new Error("invalid pattern.link.ref");
    const category = match[1];
    if (category === undefined || !CATEGORY_SET.has(category)) throw new Error("invalid pattern.link.ref");
    return ref;
}

function validateLinks(value: unknown): readonly CommunityPatternLink[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("invalid pattern.links");
    return value.map((link) => {
        if (!isRecord(link)) throw new Error("invalid pattern.link");
        const rel = str(link.rel, "pattern.link.rel");
        if (!LINK_REL_SET.has(rel)) throw new Error("invalid pattern.link");
        const ref = validatePatternRef(str(link.ref, "pattern.link.ref").trim());
        return { rel: rel as PatternLinkRel, ref };
    });
}

function validateEvidence(value: unknown): CommunityPatternEvidence {
    if (!isRecord(value)) throw new Error("invalid pattern.evidence");
    const sessions = finiteNumber(value.sessions, "pattern.evidence.sessions");
    const confidence = finiteNumber(value.confidence, "pattern.evidence.confidence");
    if (confidence > 1) throw new Error("invalid pattern.evidence.confidence");
    const trend = optionalStr(value.trend, "pattern.evidence.trend");
    if (trend !== undefined && !TREND_SET.has(trend)) throw new Error("invalid pattern.evidence.trend");
    return {
        sessions,
        confidence,
        ...(value.last_reinforced === undefined ? {} : { last_reinforced: str(value.last_reinforced, "pattern.evidence.last_reinforced") }),
        ...(trend === undefined ? {} : { trend: trend as PatternTrend }),
    };
}

export function validateCommunityPattern(value: unknown, path: string): CommunityPattern {
    const pathParts = parsePatternPath(path);
    if (pathParts === null) throw new Error("invalid community pattern path");
    if (!isRecord(value)) throw new Error("invalid pattern");

    const category = str(value.category, "pattern.category").trim();
    const name = str(value.name, "pattern.name").trim();
    if (!CATEGORY_SET.has(category)) throw new Error("invalid pattern.category");
    if (category !== pathParts.category) throw new Error(`category must match path (${pathParts.category})`);
    if (name !== pathParts.name) throw new Error(`name must match path (${pathParts.name})`);

    const evidence = validateEvidence(value.evidence);
    const links = validateLinks(value.links);
    const base = {
        key: `${pathParts.category}/${pathParts.name}`,
        category: pathParts.category,
        name: pathParts.name,
        evidence,
        ...(links === undefined ? {} : { links }),
    };

    if (category === "stack-choice") {
        const slot = str(value.slot, "pattern.slot").trim();
        if (slot === "") throw new Error("invalid pattern.slot");
        const over = maybeStringArray(value.over, "pattern.over");
        const context = optionalStr(value.context, "pattern.context");
        return {
            ...base,
            category: "stack-choice",
            slot,
            ...(over === undefined ? {} : { over }),
            ...(context === undefined ? {} : { context }),
        };
    }

    if (!PROSE_CATEGORY_SET.has(category)) throw new Error("invalid pattern.category");
    const summary = str(value.summary, "pattern.summary").trim();
    if (summary === "") throw new Error("invalid pattern.summary");
    return {
        ...base,
        category: category as ProsePatternCategory,
        summary,
    };
}

export function communityPatternRawUrl(path: string): string {
    if (parsePatternPath(path) === null) throw new Error("invalid community pattern path");
    return `${REPO_RAW}/${path}`;
}

export function communityPatternCommitsUrl(path: string): string {
    if (parsePatternPath(path) === null) throw new Error("invalid community pattern path");
    return `${REPO_API}/commits?sha=main&path=${encodeURIComponent(path)}&per_page=1`;
}

async function fetchJson(url: string, fetchImpl: FetchLike): Promise<unknown> {
    const response = await fetchImpl(url);
    if (response.status === 404) throw Object.assign(new Error("not found"), { notFound: true });
    if (!response.ok) throw new Error(`fetch failed (${response.status})`);
    return response.json();
}

function validateTreePaths(value: unknown): string[] {
    if (!isRecord(value) || !Array.isArray(value.tree)) throw new Error("invalid pattern tree");
    if (value.truncated === true) throw new Error("pattern tree truncated");
    const paths: string[] = [];
    for (const row of value.tree) {
        if (!isRecord(row) || row.type !== "blob" || typeof row.path !== "string") continue;
        if (parsePatternPath(row.path) !== null) paths.push(row.path);
    }
    return paths.sort((a, b) => {
        const ap = parsePatternPath(a);
        const bp = parsePatternPath(b);
        if (ap === null || bp === null) return a.localeCompare(b);
        return patternCategoryOrder(ap.category) - patternCategoryOrder(bp.category)
            || ap.name.localeCompare(bp.name);
    });
}

async function fetchPatternAuthor(path: string, fetchImpl: FetchLike): Promise<CommunityPatternAuthor | undefined> {
    try {
        const raw = await fetchJson(communityPatternCommitsUrl(path), fetchImpl);
        if (!Array.isArray(raw)) return undefined;
        const first = raw[0];
        if (!isRecord(first) || !isRecord(first.author)) return undefined;
        const login = first.author.login;
        return typeof login === "string" && LOGIN_RE.test(login) ? { login } : undefined;
    } catch {
        return undefined;
    }
}

function withAuthor(pattern: CommunityPattern, author: CommunityPatternAuthor | undefined): CommunityPattern {
    return author === undefined ? pattern : { ...pattern, author };
}

export async function fetchCommunityPatterns(
    opts: { readonly fetch?: FetchLike } = {},
): Promise<CommunityPatternsResult> {
    const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const paths = validateTreePaths(await fetchJson(COMMUNITY_PATTERN_TREE_URL, fetchImpl));
    const settled = await Promise.all(paths.map(async (path): Promise<
        | { readonly kind: "pattern"; readonly pattern: CommunityPattern }
        | { readonly kind: "drop"; readonly drop: CommunityPatternDrop }
    > => {
        try {
            const raw = await fetchJson(communityPatternRawUrl(path), fetchImpl);
            const pattern = validateCommunityPattern(raw, path);
            const author = await fetchPatternAuthor(path, fetchImpl);
            return { kind: "pattern", pattern: withAuthor(pattern, author) };
        } catch (error) {
            return {
                kind: "drop",
                drop: { path, reason: error instanceof Error ? error.message : String(error) },
            };
        }
    }));

    const patterns: CommunityPattern[] = [];
    const dropped: CommunityPatternDrop[] = [];
    for (const row of settled) {
        if (row.kind === "pattern") patterns.push(row.pattern);
        else dropped.push(row.drop);
    }
    return { patterns: sortPatterns(patterns), dropped };
}

export function groupPatternsByCategory(patterns: readonly CommunityPattern[]): PatternCategoryGroup[] {
    const sorted = sortPatterns(patterns);
    return PATTERN_CATEGORIES.map((category) => {
        const rows = sorted.filter((pattern) => pattern.category === category);
        return {
            category,
            label: PATTERN_CATEGORY_LABELS[category],
            count: rows.length,
            patterns: rows,
        };
    });
}

export function patternAnchorId(ref: string): string {
    const slug = ref.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `pattern-${slug}`;
}
