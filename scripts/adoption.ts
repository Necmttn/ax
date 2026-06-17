// scripts/adoption.ts
/**
 * Zero-consent adoption report for ax (Tier 1 OSS analytics).
 *
 * Pulls every adoption signal that needs NO phone-home and NO user consent:
 *   - GitHub release asset download counts (the install proxy: each binary
 *     download ≈ one install/upgrade), per-version + per-platform + all-time.
 *     This is the most trustworthy install metric we have - install.sh
 *     ultimately fetches these binaries.
 *   - GitHub stars / forks / open issues (issues only, PRs excluded)
 *   - npm download stats for `axctl` (only if/when it is published; degrades
 *     to a "not published" note today)
 *
 * Run:  bun scripts/adoption.ts            # human table
 *       bun scripts/adoption.ts --json     # machine-readable
 *
 * Auth: uses GH_TOKEN / GITHUB_TOKEN when set, else falls back to `gh auth
 * token`, else hits the public API unauthenticated (60 req/hr).
 *
 * NOT counted here, by design:
 *   - install.sh fetches (`curl | sh`): a fetch runs no JS and is NOT an
 *     install - it counts retries, bots, browser previews, and mirrors. The
 *     binary download_count above is the cleaner proxy. For raw site/page
 *     traffic, enable Cloudflare Web Analytics on the Pages project instead of
 *     instrumenting the installer route.
 *   - `npx skills add` (a third-party tool clones GitHub directly, no stat).
 */

const REPO = process.env.AX_ADOPTION_REPO ?? "Necmttn/ax";
const NPM_PKG = process.env.AX_ADOPTION_NPM ?? "axctl";
const JSON_OUT = process.argv.includes("--json");

// Token resolution: env first, then the gh CLI (so a developer who ran
// `gh auth login` gets the higher authenticated rate limit for free).
const ghToken = (): string => {
    const env = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (env) return env;
    try {
        const out = Bun.spawnSync(["gh", "auth", "token"]).stdout.toString().trim();
        return out;
    } catch {
        return "";
    }
};
const TOKEN = ghToken();

type Asset = { name: string; download_count: number };
type Release = { tag_name: string; published_at: string; assets: Asset[] };

const gh = async <T>(path: string): Promise<T> => {
    const res = await fetch(`https://api.github.com/${path}`, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "ax-adoption",
            ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
    });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
};

/** All releases across pages (per_page=100), so all-time totals stay accurate
 *  once the repo passes 100 releases. */
const allReleases = async (): Promise<Release[]> => {
    const out: Release[] = [];
    for (let page = 1; ; page++) {
        const batch = await gh<Release[]>(`repos/${REPO}/releases?per_page=100&page=${page}`);
        out.push(...batch);
        if (batch.length < 100) break;
    }
    return out;
};

/** Open issues EXCLUDING pull requests (the repo endpoint's open_issues_count
 *  conflates the two). search/issues total_count is the real issue count. */
const openIssues = async (): Promise<number> => {
    const r = await gh<{ total_count: number }>(
        `search/issues?q=${encodeURIComponent(`repo:${REPO} type:issue state:open`)}&per_page=1`,
    );
    return r.total_count;
};

/** npm download point stat; returns null when the package is unpublished (404). */
const npmDownloads = async (period: "last-week" | "last-month") => {
    const res = await fetch(`https://api.npmjs.org/downloads/point/${period}/${NPM_PKG}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`npm ${period} -> ${res.status}`);
    return (await res.json()) as { downloads: number; start: string; end: string };
};

const isTarball = (name: string) => name.endsWith(".tar.gz");
const platformOf = (name: string) =>
    name.replace(/^axctl-/, "").replace(/\.tar\.gz$/, "") || name;

const main = async () => {
    const [repo, releases, issues, npmWeek, npmMonth] = await Promise.all([
        gh<{ stargazers_count: number; forks_count: number; subscribers_count: number }>(`repos/${REPO}`),
        allReleases(),
        openIssues(),
        npmDownloads("last-week"),
        npmDownloads("last-month"),
    ]);

    const allAssets = releases.flatMap((r) => r.assets).filter((a) => isTarball(a.name));
    const totalDownloads = allAssets.reduce((n, a) => n + a.download_count, 0);

    // Keep every release with downloads, plus the 5 newest (so a brand-new
    // release with 0 downloads yet still shows up at the top).
    const newestTags = new Set(releases.slice(0, 5).map((r) => r.tag_name));
    const perRelease = releases
        .map((r) => ({
            tag: r.tag_name,
            published_at: r.published_at,
            downloads: r.assets.filter((a) => isTarball(a.name)).reduce((n, a) => n + a.download_count, 0),
        }))
        .filter((r) => r.downloads > 0 || newestTags.has(r.tag));

    const byPlatform: Record<string, number> = {};
    for (const a of allAssets) {
        const plat = platformOf(a.name);
        byPlatform[plat] = (byPlatform[plat] ?? 0) + a.download_count;
    }

    const report = {
        repo: REPO,
        github: {
            stars: repo.stargazers_count,
            forks: repo.forks_count,
            watchers: repo.subscribers_count,
            open_issues: issues,
        },
        installs: {
            total_binary_downloads: totalDownloads,
            by_platform: byPlatform,
            by_release: perRelease,
        },
        npm: npmWeek
            ? { package: NPM_PKG, last_week: npmWeek.downloads, last_month: npmMonth?.downloads ?? null }
            : { package: NPM_PKG, published: false },
    };

    if (JSON_OUT) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    const L = (s: string) => console.log(s);
    L(`\n  ax adoption - ${REPO}\n  ${"─".repeat(40)}`);
    L(`  stars        ${report.github.stars}`);
    L(`  forks        ${report.github.forks}`);
    L(`  open issues  ${report.github.open_issues}`);
    L(`\n  binary downloads (install proxy)`);
    L(`  all-time     ${totalDownloads}`);
    for (const [plat, n] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
        const pct = totalDownloads ? Math.round((n / totalDownloads) * 100) : 0;
        L(`    ${plat.padEnd(16)} ${String(n).padStart(5)}  (${pct}%)`);
    }
    L(`\n  recent releases`);
    for (const r of perRelease.slice(0, 8)) L(`    ${r.tag.padEnd(10)} ${String(r.downloads).padStart(4)}`);
    L(`\n  npm (${NPM_PKG})`);
    if (npmWeek) L(`    last week ${npmWeek.downloads}   last month ${npmMonth?.downloads ?? "?"}`);
    else L(`    not published - no npm download stats (publish to gain free weekly analytics)`);
    L("");
};

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
