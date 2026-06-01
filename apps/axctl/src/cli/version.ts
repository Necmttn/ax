import { spawnSync } from "node:child_process";

export const AX_VERSION = "0.6.0"; // x-release-please-version
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

export async function printVersion(args: string[], deps: VersionDeps): Promise<void> {
    const json = args.includes("--json");
    const check = args.includes("--check") || json;
    const banner = args.includes("--banner");
    let latest: LatestRelease | null = null;
    if (check) {
        latest = await deps.fetchLatestRelease(DEFAULT_REPO);
    }
    const status = versionStatus(AX_VERSION, latest);
    if (json) {
        console.log(JSON.stringify(status, null, 2));
        return;
    }
    if (banner) {
        const { BANNER } = await import("./banner.ts");
        console.log(BANNER);
    }
    console.log(formatVersionStatus(status));
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

export const liveVersionDeps: VersionDeps = {
    fetchLatestRelease,
    fetchInstallScript,
    runInstallScript,
};
