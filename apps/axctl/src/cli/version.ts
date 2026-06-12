import { spawnSync } from "node:child_process";

export const AX_VERSION = "0.29.0"; // x-release-please-version
export const DEFAULT_REPO = "Necmttn/ax";

export interface LatestRelease {
    readonly tagName: string;
    readonly url: string | null;
}

export interface VersionStatus {
    readonly current: string;
    readonly latest: string | null;
    readonly latestUrl: string | null;
    readonly updateAvailable: boolean | null;
}

export interface VersionDeps {
    readonly fetchLatestRelease: (repo: string) => Promise<LatestRelease>;
    readonly fetchInstallScript: (repo: string) => Promise<string>;
    readonly runInstallScript: (script: string, env: NodeJS.ProcessEnv) => Promise<number>;
    readonly env?: NodeJS.ProcessEnv;
    /** Resolve the git provenance of the running build (local, no network). */
    readonly resolveProvenance?: () => GitProvenance | null;
}

/** Where the provenance came from: a live source checkout, or baked into the binary at build time. */
export type ProvenanceSource = "git" | "baked";

export interface GitProvenance {
    /** Raw `git describe` string this was derived from. */
    readonly describe: string;
    /** Nearest tag (e.g. "v0.7.0"), or null for an untagged build. */
    readonly tag: string | null;
    /** Abbreviated commit sha (without the `g` prefix). */
    readonly sha: string;
    /** Commits since `tag` (0 when the build is exactly on the tag). */
    readonly commitsAhead: number;
    /** Uncommitted changes in the working tree at build/run time. */
    readonly dirty: boolean;
    /** Current branch when read from a live checkout; null for a baked binary. */
    readonly branch: string | null;
    readonly source: ProvenanceSource;
}

export interface ProvenanceDeps {
    /** Run `git <args>` against the ax source tree; return trimmed stdout, or null if git is unavailable. */
    readonly runGit: (args: string[]) => string | null;
    /** `git describe` string baked at build time (for the compiled binary); empty when not baked. */
    readonly bakedDescribe: string;
}

export interface ParsedDescribe {
    readonly tag: string | null;
    readonly commitsAhead: number;
    readonly sha: string;
    readonly dirty: boolean;
}

/** Parse `git describe --tags --always --dirty --long` output into its parts. */
export function parseGitDescribe(input: string): ParsedDescribe {
    let s = input.trim();
    const dirty = s.endsWith("-dirty");
    if (dirty) s = s.slice(0, -"-dirty".length);
    // tagged --long form: <tag>-<commitsAhead>-g<sha>
    const m = s.match(/^(.+)-(\d+)-g([0-9a-fA-F]+)$/);
    if (m) {
        return { tag: m[1], commitsAhead: Number.parseInt(m[2], 10), sha: m[3], dirty };
    }
    // untagged --always form: a bare short sha (or "unknown")
    return { tag: null, commitsAhead: 0, sha: s, dirty };
}

function provenanceFrom(
    parsed: ParsedDescribe,
    describe: string,
    branch: string | null,
    source: ProvenanceSource,
): GitProvenance {
    return {
        describe,
        tag: parsed.tag,
        sha: parsed.sha,
        commitsAhead: parsed.commitsAhead,
        dirty: parsed.dirty,
        branch,
        source,
    };
}

/** Resolve build provenance: prefer the live source checkout, fall back to the baked describe, else null. */
export function resolveGitProvenance(deps: ProvenanceDeps): GitProvenance | null {
    const live = deps.runGit(["describe", "--tags", "--always", "--dirty", "--long"]);
    if (live) {
        const branch = deps.runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
        return provenanceFrom(
            parseGitDescribe(live),
            live,
            branch && branch !== "HEAD" ? branch : null,
            "git",
        );
    }
    if (deps.bakedDescribe) {
        return provenanceFrom(parseGitDescribe(deps.bakedDescribe), deps.bakedDescribe, null, "baked");
    }
    return null;
}

/** Render the human-readable build provenance lines (empty when provenance is unknown). */
export function formatProvenance(prov: GitProvenance | null): string[] {
    if (prov === null) return [];
    const lines: string[] = [];
    const sha = `g${prov.sha}`;
    if (prov.tag === null) {
        lines.push(`build: untagged (${prov.dirty ? `${sha}, dirty` : sha})`);
    } else {
        const ahead = prov.commitsAhead > 0 ? `+${prov.commitsAhead}` : "";
        const flags = prov.dirty ? `${sha}, dirty` : sha;
        const clean = prov.commitsAhead === 0 && !prov.dirty;
        const verdict = clean
            ? `release tag ${prov.tag}`
            : prov.commitsAhead > 0
                ? `ahead of release tag ${prov.tag}${prov.dirty ? " + uncommitted changes" : ""}`
                : `release tag ${prov.tag} + uncommitted changes`;
        lines.push(`build: ${prov.tag}${ahead} (${flags}) - ${verdict}`);
    }
    if (prov.branch) lines.push(`branch: ${prov.branch}`);
    if (prov.source === "baked") lines.push("source: compiled binary");
    return lines;
}

function normalizeVersion(input: string): number[] {
    const raw = input.trim().replace(/^v/i, "");
    const main = raw.split(/[+-]/)[0] ?? "";
    return main.split(".").map((part) => {
        const value = Number.parseInt(part, 10);
        return Number.isFinite(value) ? value : 0;
    });
}

export function compareVersions(a: string, b: string): number {
    const left = normalizeVersion(a);
    const right = normalizeVersion(b);
    const len = Math.max(left.length, right.length, 3);
    for (let i = 0; i < len; i += 1) {
        const l = left[i] ?? 0;
        const r = right[i] ?? 0;
        if (l > r) return 1;
        if (l < r) return -1;
    }
    return 0;
}

export function versionStatus(current: string, latest: LatestRelease | null): VersionStatus {
    if (latest === null) {
        return {
            current,
            latest: null,
            latestUrl: null,
            updateAvailable: null,
        };
    }
    return {
        current,
        latest: latest.tagName,
        latestUrl: latest.url,
        updateAvailable: compareVersions(current, latest.tagName) < 0,
    };
}

function githubToken(): string | null {
    const envToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (envToken) return envToken;
    const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
    if (gh.status !== 0) return null;
    return gh.stdout.trim() || null;
}

async function githubFetch(path: string, accept: string): Promise<Response> {
    const token = githubToken();
    const headers: Record<string, string> = {
        accept,
        "user-agent": `axctl/${AX_VERSION}`,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(`https://api.github.com/${path}`, { headers });
}

export async function fetchLatestRelease(repo: string): Promise<LatestRelease> {
    const res = await githubFetch(`repos/${repo}/releases/latest`, "application/vnd.github+json");
    if (!res.ok) {
        throw new Error(`GitHub latest release lookup failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    const tagName = typeof data.tag_name === "string" ? data.tag_name : "";
    if (!tagName) throw new Error("GitHub latest release response did not include tag_name");
    return {
        tagName,
        url: typeof data.html_url === "string" ? data.html_url : null,
    };
}

export async function fetchInstallScript(repo: string): Promise<string> {
    const res = await githubFetch(
        `repos/${repo}/contents/install.sh`,
        "application/vnd.github.raw",
    );
    if (!res.ok) {
        throw new Error(`GitHub install.sh lookup failed: HTTP ${res.status}`);
    }
    return res.text();
}

export async function runInstallScript(
    script: string,
    env: NodeJS.ProcessEnv,
): Promise<number> {
    const proc = Bun.spawn(["bash"], {
        env,
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
    });
    proc.stdin.write(script);
    proc.stdin.end();
    await proc.exited;
    return proc.exitCode ?? 1;
}

export function formatVersionStatus(status: VersionStatus): string {
    const lines = [`axctl ${status.current}`];
    if (status.latest === null) {
        lines.push("latest: unknown");
        return lines.join("\n");
    }
    lines.push(`latest: ${status.latest}`);
    lines.push(
        status.updateAvailable ? "update: available" : "update: current",
    );
    if (status.latestUrl) lines.push(`release: ${status.latestUrl}`);
    return lines.join("\n");
}

/**
 * Render the full `ax -v` text report: version + local build provenance, then
 * either the latest-release comparison (when `--check`ed) or a hint about it.
 */
export function formatVersionReport(
    status: VersionStatus,
    prov: GitProvenance | null,
    opts: { readonly checked: boolean },
): string {
    const lines = [`axctl ${status.current}`];
    lines.push(...formatProvenance(prov));
    if (status.latest !== null) {
        lines.push(`latest: ${status.latest}`);
        lines.push(status.updateAvailable ? "update: available" : "update: current");
        if (status.latestUrl) lines.push(`release: ${status.latestUrl}`);
    } else if (opts.checked) {
        lines.push("latest: unknown");
    } else {
        lines.push("");
        lines.push("(run `ax -v --check` to compare against the newest GitHub release)");
    }
    return lines.join("\n");
}

export async function printVersion(args: string[], deps: VersionDeps): Promise<void> {
    const json = args.includes("--json");
    const check = args.includes("--check") || json;
    const banner = args.includes("--banner");
    let latest: LatestRelease | null = null;
    if (check) {
        latest = await deps.fetchLatestRelease(DEFAULT_REPO);
    }
    const status = versionStatus(AX_VERSION, latest);
    const provenance = (deps.resolveProvenance ?? liveResolveProvenance)();
    if (json) {
        console.log(JSON.stringify({ ...status, provenance }, null, 2));
        return;
    }
    if (banner) {
        const { BANNER } = await import("./banner.ts");
        console.log(BANNER);
    }
    console.log(formatVersionReport(status, provenance, { checked: check }));
}

export async function updateAxctl(args: string[], deps: VersionDeps): Promise<void> {
    const checkOnly = args.includes("--check");
    const json = args.includes("--json");
    const latest = await deps.fetchLatestRelease(DEFAULT_REPO);
    const status = versionStatus(AX_VERSION, latest);
    if (checkOnly) {
        console.log(json ? JSON.stringify(status, null, 2) : formatVersionStatus(status));
        return;
    }
    if (status.updateAvailable === false) {
        console.log(formatVersionStatus(status));
        return;
    }

    console.log(`updating axctl ${AX_VERSION} -> ${latest.tagName}`);
    const script = await deps.fetchInstallScript(DEFAULT_REPO);
    const env = {
        ...(deps.env ?? process.env),
        AXCTL_VERSION: "latest",
    };
    const code = await deps.runInstallScript(script, env);
    if (code !== 0) {
        throw new Error(`axctl update failed with exit code ${code}`);
    }
}

/**
 * `git describe` baked at build time via `bun build --define AX_BUILD_GIT="..."`
 * (see scripts/build-axctl.ts). Absent when running from source, where
 * `typeof` on the undeclared global safely yields "undefined".
 */
declare const AX_BUILD_GIT: string;
const bakedGitDescribe: string = typeof AX_BUILD_GIT === "string" ? AX_BUILD_GIT : "";

function liveRunGit(args: string[]): string | null {
    // Read the ax source tree's git (where this file lives), NOT the user's cwd.
    const res = spawnSync("git", ["-C", import.meta.dir, ...args], { encoding: "utf8" });
    if (res.status !== 0) return null;
    const out = res.stdout.trim();
    return out || null;
}

export const liveProvenanceDeps: ProvenanceDeps = {
    runGit: liveRunGit,
    bakedDescribe: bakedGitDescribe,
};

export function liveResolveProvenance(): GitProvenance | null {
    return resolveGitProvenance(liveProvenanceDeps);
}

export const liveVersionDeps: VersionDeps = {
    fetchLatestRelease,
    fetchInstallScript,
    runInstallScript,
    resolveProvenance: liveResolveProvenance,
};
