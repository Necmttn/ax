// apps/site/app/lib/adoption.ts
//
// Browser-side adoption stats for the unlisted /status page. Mirrors the
// zero-consent signals from scripts/adoption.ts, but fetched live & client-side
// (like app/lib/community.ts) so the page is always current with no backend.
//
// Sources (all CORS-enabled, unauthenticated):
//   - api.github.com/repos/<repo>            stars, forks, watchers
//   - api.github.com/repos/<repo>/releases   asset download_count (install proxy)
//   - api.github.com/search/issues           open issues, PRs excluded
//   - api.npmjs.org/downloads                 npm downloads (null until published)
//
// Unauthenticated GitHub is 60 req/hr per IP; this page makes ~3 calls and is
// unlisted, so that's plenty. install.sh `curl|sh` fetches are deliberately NOT
// shown - a fetch is not an install (bots/retries/mirrors); download_count is
// the honest proxy.

const REPO = "Necmttn/ax";
const NPM_PKG = "axctl";

export interface ReleaseStat {
    readonly tag: string;
    readonly downloads: number;
    readonly publishedAt: string;
}

export interface AdoptionStats {
    readonly repo: string;
    readonly stars: number;
    readonly forks: number;
    readonly watchers: number;
    readonly openIssues: number;
    readonly totalDownloads: number;
    readonly byPlatform: ReadonlyArray<{ platform: string; downloads: number }>;
    readonly releases: ReadonlyArray<ReleaseStat>;
    readonly npm: { lastWeek: number; lastMonth: number } | null;
}

interface RawAsset {
    name: string;
    download_count: number;
}
interface RawRelease {
    tag_name: string;
    published_at: string;
    assets: RawAsset[];
}

async function ghJson<T>(path: string): Promise<T> {
    const res = await fetch(`https://api.github.com/${path}`, {
        headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub ${path} -> ${res.status}`);
    return res.json() as Promise<T>;
}

const isTarball = (name: string) => name.endsWith(".tar.gz");
// Strip both the current (axctl-) and pre-rename (agentctl-) prefixes so old
// binary downloads fold into the same platform bucket (still counted, just not
// shown as a separate row).
const platformOf = (name: string) =>
    name.replace(/^(axctl|agentctl)-/, "").replace(/\.tar\.gz$/, "") || name;

/** All releases across pages (capped at 5 pages = 500 releases to bound the
 *  unauthenticated rate-limit cost; ax has ~30 today). */
async function allReleases(): Promise<RawRelease[]> {
    const out: RawRelease[] = [];
    for (let page = 1; page <= 5; page++) {
        const batch = await ghJson<RawRelease[]>(`repos/${REPO}/releases?per_page=100&page=${page}`);
        out.push(...batch);
        if (batch.length < 100) break;
    }
    return out;
}

/** Open issues EXCLUDING pull requests (repo.open_issues_count conflates them). */
async function openIssues(): Promise<number> {
    const r = await ghJson<{ total_count: number }>(
        `search/issues?q=${encodeURIComponent(`repo:${REPO} type:issue state:open`)}&per_page=1`,
    );
    return r.total_count;
}

async function npmPoint(period: "last-week" | "last-month"): Promise<number | null> {
    const res = await fetch(`https://api.npmjs.org/downloads/point/${period}/${NPM_PKG}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return ((await res.json()) as { downloads: number }).downloads;
}

export async function fetchAdoption(): Promise<AdoptionStats> {
    const [repo, releases, issues, npmWeek, npmMonth] = await Promise.all([
        ghJson<{ stargazers_count: number; forks_count: number; subscribers_count: number }>(`repos/${REPO}`),
        allReleases(),
        openIssues(),
        npmPoint("last-week"),
        npmPoint("last-month"),
    ]);

    const assets = releases.flatMap((r) => r.assets).filter((a) => isTarball(a.name));
    const totalDownloads = assets.reduce((n, a) => n + a.download_count, 0);

    const platMap = new Map<string, number>();
    for (const a of assets) platMap.set(platformOf(a.name), (platMap.get(platformOf(a.name)) ?? 0) + a.download_count);
    const byPlatform = [...platMap.entries()]
        .map(([platform, downloads]) => ({ platform, downloads }))
        .sort((a, b) => b.downloads - a.downloads);

    const relStats: ReleaseStat[] = releases
        .map((r) => ({
            tag: r.tag_name,
            publishedAt: r.published_at,
            downloads: r.assets.filter((a) => isTarball(a.name)).reduce((n, a) => n + a.download_count, 0),
        }))
        .slice(0, 10);

    return {
        repo: REPO,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        watchers: repo.subscribers_count,
        openIssues: issues,
        totalDownloads,
        byPlatform,
        releases: relStats,
        npm: npmWeek !== null ? { lastWeek: npmWeek, lastMonth: npmMonth ?? 0 } : null,
    };
}
