import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export const ARCHIVE_NAMES = [
    "axctl-darwin-arm64.tar.gz",
    "axctl-darwin-x64.tar.gz",
    "axctl-linux-x64.tar.gz",
] as const;
export const CHECKSUMS_NAME = "checksums.txt";
export const ASSET_NAMES = [...ARCHIVE_NAMES, CHECKSUMS_NAME] as const;

export interface GitHubAsset {
    readonly name: string;
    readonly size: number;
}

export interface GitHubRelease {
    readonly id: string;
    readonly tagName: string;
    readonly targetCommitish: string;
    readonly isDraft: boolean;
    readonly isPrerelease: boolean;
    readonly assets: readonly GitHubAsset[];
}

export interface GitHubAdapter {
    getRelease(repo: string, tag: string): Promise<GitHubRelease | null>;
    getTagCommit(repo: string, tag: string): Promise<string | null>;
    getLatestRelease(repo: string): Promise<GitHubRelease | null>;
    isCommitOnMain(repo: string, sha: string): Promise<boolean>;
    uploadAssets(repo: string, tag: string, paths: readonly string[]): Promise<void>;
    downloadAsset(repo: string, tag: string, name: string, destination: string): Promise<void>;
    publishRelease(repo: string, tag: string, makeLatest: boolean): Promise<void>;
}

export interface ReleaseIdentity {
    readonly tag: string;
    readonly releaseId: string;
    readonly commitSha: string;
    readonly published: boolean;
}

export interface ResolveReleaseInput {
    readonly repo: string;
    readonly tag: string;
    readonly automaticSha?: string;
}

function fail(message: string): never {
    throw new Error(message);
}

export function validateRepo(repo: string): string {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail(`invalid repository: ${repo}`);
    return repo;
}

export function validateTag(tag: string): string {
    if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
        fail(`invalid stable release tag: ${tag}`);
    }
    return tag;
}

export function validateCommitSha(sha: string): string {
    if (!/^[0-9a-f]{40}$/i.test(sha)) fail("release commit must be a full 40-character SHA");
    return sha.toLowerCase();
}

export function validateReleaseId(id: string): string {
    if (!/^\d+$/.test(id)) fail("release ID must be numeric");
    return id;
}

function assertSameIdentity(release: GitHubRelease, identity: ReleaseIdentity): void {
    if (release.id !== identity.releaseId || release.tagName !== identity.tag) {
        fail(`release identity changed for ${identity.tag}`);
    }
    if (validateCommitSha(release.targetCommitish) !== identity.commitSha) {
        fail(`release target changed for ${identity.tag}`);
    }
}

async function loadCheckedRelease(
    adapter: GitHubAdapter,
    repo: string,
    identity: ReleaseIdentity,
): Promise<GitHubRelease> {
    const release = await adapter.getRelease(repo, identity.tag);
    if (!release) fail(`release ${identity.tag} does not exist`);
    assertSameIdentity(release, identity);
    const tagCommit = await adapter.getTagCommit(repo, identity.tag);
    if (!tagCommit || validateCommitSha(tagCommit) !== identity.commitSha) {
        fail(`tag ${identity.tag} does not point to ${identity.commitSha}`);
    }
    return release;
}

export async function resolveRelease(
    adapter: GitHubAdapter,
    input: ResolveReleaseInput,
): Promise<ReleaseIdentity> {
    const repo = validateRepo(input.repo);
    const tag = validateTag(input.tag);
    const release = await adapter.getRelease(repo, tag);
    if (!release) fail(`release ${tag} does not exist`);
    if (release.tagName !== tag) fail(`release lookup returned a different tag for ${tag}`);
    if (release.isPrerelease) fail(`release ${tag} is a prerelease`);

    const releaseId = validateReleaseId(release.id);
    const commitSha = validateCommitSha(release.targetCommitish);
    const tagCommit = await adapter.getTagCommit(repo, tag);
    if (!tagCommit || validateCommitSha(tagCommit) !== commitSha) {
        fail(`release ${tag} and its tag do not identify the same commit`);
    }
    if (input.automaticSha && validateCommitSha(input.automaticSha) !== commitSha) {
        fail(`release-please reported a different commit for ${tag}`);
    }
    if (!(await adapter.isCommitOnMain(repo, commitSha))) {
        fail(`release commit ${commitSha} is not in main history`);
    }

    return { tag, releaseId, commitSha, published: !release.isDraft };
}

function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertExactNames(directory: string, expected: readonly string[]): void {
    const actual = readdirSync(directory).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
        fail(`asset names differ: expected ${wanted.join(", ")}; found ${actual.join(", ")}`);
    }
}

function requireNonempty(path: string): void {
    if (!statSync(path).isFile() || statSync(path).size === 0) fail(`asset is empty: ${basename(path)}`);
}

export function prepareLocalAssets(directory: string): readonly string[] {
    const absolute = resolve(directory);
    const archives = readdirSync(absolute).filter((name) => name.endsWith(".tar.gz"));
    const wanted = [...ARCHIVE_NAMES].sort();
    if (archives.length !== wanted.length || archives.sort().some((name, index) => name !== wanted[index])) {
        fail(`archive names differ: expected ${wanted.join(", ")}; found ${archives.sort().join(", ")}`);
    }

    const lines = ARCHIVE_NAMES.map((name) => {
        const path = join(absolute, name);
        requireNonempty(path);
        return `${sha256(path)}  ${name}`;
    });
    const checksumPath = join(absolute, CHECKSUMS_NAME);
    writeFileSync(checksumPath, `${lines.join("\n")}\n`, { mode: 0o644 });
    return ASSET_NAMES.map((name) => join(absolute, name));
}

export function verifyDownloadedAssets(directory: string): void {
    const absolute = resolve(directory);
    assertExactNames(absolute, ASSET_NAMES);
    for (const name of ASSET_NAMES) requireNonempty(join(absolute, name));

    const lines = readFileSync(join(absolute, CHECKSUMS_NAME), "utf8").split("\n").filter(Boolean);
    if (lines.length !== ARCHIVE_NAMES.length) fail("checksums.txt must contain exactly three entries");
    const hashes = new Map<string, string>();
    for (const line of lines) {
        const match = /^([0-9a-f]{64})  (?:\.\/)?(axctl-(?:darwin-(?:arm64|x64)|linux-x64)\.tar\.gz)$/.exec(
            line,
        );
        if (!match || hashes.has(match[2]!)) fail("checksums.txt has invalid or duplicate entries");
        hashes.set(match[2]!, match[1]!);
    }
    for (const name of ARCHIVE_NAMES) {
        if (hashes.get(name) !== sha256(join(absolute, name))) fail(`checksum failed for ${name}`);
    }
}

function assertKnownRemoteAssets(release: GitHubRelease): void {
    const allowed = new Set<string>(ASSET_NAMES);
    const unexpected = release.assets.map((asset) => asset.name).filter((name) => !allowed.has(name));
    if (unexpected.length > 0) fail(`release has unexpected assets: ${unexpected.join(", ")}`);
}

async function downloadAndVerify(
    adapter: GitHubAdapter,
    repo: string,
    identity: ReleaseIdentity,
    stagedDirectory?: string,
): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "ax-release-assets-"));
    try {
        for (const name of ASSET_NAMES) {
            await adapter.downloadAsset(repo, identity.tag, name, directory);
        }
        verifyDownloadedAssets(directory);
        if (stagedDirectory) {
            for (const name of ASSET_NAMES) {
                if (sha256(join(directory, name)) !== sha256(join(stagedDirectory, name))) {
                    fail(`downloaded asset differs from staged asset: ${name}`);
                }
            }
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

function compareTags(left: string, right: string): number {
    const a = validateTag(left).slice(1).split(".").map(BigInt);
    const b = validateTag(right).slice(1).split(".").map(BigInt);
    for (let index = 0; index < 3; index += 1) {
        if (a[index]! < b[index]!) return -1;
        if (a[index]! > b[index]!) return 1;
    }
    return 0;
}

export async function publishReleaseAssets(
    adapter: GitHubAdapter,
    repoInput: string,
    identity: ReleaseIdentity,
    directory: string,
): Promise<void> {
    const repo = validateRepo(repoInput);
    validateIdentity(identity);
    const before = await loadCheckedRelease(adapter, repo, identity);
    if (!before.isDraft) fail(`release ${identity.tag} is already published; use verify mode`);
    assertKnownRemoteAssets(before);

    const paths = prepareLocalAssets(directory);
    await adapter.uploadAssets(repo, identity.tag, paths);
    await downloadAndVerify(adapter, repo, identity, resolve(directory));

    const after = await loadCheckedRelease(adapter, repo, identity);
    if (!after.isDraft) fail(`release ${identity.tag} was published during verification`);
    assertKnownRemoteAssets(after);

    const latest = await adapter.getLatestRelease(repo);
    const makeLatest = latest === null || compareTags(identity.tag, latest.tagName) > 0;
    await adapter.publishRelease(repo, identity.tag, makeLatest);
}

export async function verifyPublishedRelease(
    adapter: GitHubAdapter,
    repoInput: string,
    identity: ReleaseIdentity,
): Promise<void> {
    const repo = validateRepo(repoInput);
    validateIdentity(identity);
    const release = await loadCheckedRelease(adapter, repo, identity);
    if (release.isDraft) fail(`release ${identity.tag} is still a draft; use publish mode`);
    assertKnownRemoteAssets(release);
    await downloadAndVerify(adapter, repo, identity);
    const after = await loadCheckedRelease(adapter, repo, identity);
    if (after.isDraft) fail(`release ${identity.tag} changed state during verification`);
    assertKnownRemoteAssets(after);
}

function validateIdentity(identity: ReleaseIdentity): void {
    validateTag(identity.tag);
    validateReleaseId(identity.releaseId);
    validateCommitSha(identity.commitSha);
}

function runGh(args: readonly string[]): string {
    const result = spawnSync("gh", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) fail((result.stderr || `gh exited ${result.status}`).trim());
    return result.stdout;
}

interface GhReleaseJson {
    readonly databaseId: number;
    readonly tagName: string;
    readonly targetCommitish: string;
    readonly isDraft: boolean;
    readonly isPrerelease: boolean;
    readonly assets: readonly { readonly name: string; readonly size: number }[];
}

function parseGhRelease(text: string): GitHubRelease {
    const value = JSON.parse(text) as GhReleaseJson;
    return {
        id: String(value.databaseId),
        tagName: value.tagName,
        targetCommitish: value.targetCommitish,
        isDraft: value.isDraft,
        isPrerelease: value.isPrerelease,
        assets: value.assets.map((asset) => ({ name: asset.name, size: asset.size })),
    };
}

const RELEASE_FIELDS = "databaseId,tagName,targetCommitish,isDraft,isPrerelease,assets";

export class GhCliAdapter implements GitHubAdapter {
    async getRelease(repo: string, tag: string): Promise<GitHubRelease | null> {
        const result = spawnSync("gh", ["release", "view", tag, "--repo", repo, "--json", RELEASE_FIELDS], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.status !== 0) {
            if (/release not found|not found|HTTP 404/i.test(result.stderr)) return null;
            fail((result.stderr || `gh exited ${result.status}`).trim());
        }
        return parseGhRelease(result.stdout);
    }

    async getTagCommit(repo: string, tag: string): Promise<string | null> {
        const ref = spawnSync("gh", ["api", `repos/${repo}/git/ref/tags/${tag}`], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (ref.status !== 0) {
            if (/not found|HTTP 404/i.test(ref.stderr)) return null;
            fail((ref.stderr || `gh exited ${ref.status}`).trim());
        }
        let object = (JSON.parse(ref.stdout) as { object: { type: string; sha: string } }).object;
        for (let depth = 0; object.type === "tag" && depth < 8; depth += 1) {
            const tagObject = JSON.parse(runGh(["api", `repos/${repo}/git/tags/${validateCommitSha(object.sha)}`])) as {
                object: { type: string; sha: string };
            };
            object = tagObject.object;
        }
        if (object.type !== "commit") fail(`tag ${tag} does not resolve to a commit`);
        return validateCommitSha(object.sha);
    }

    async getLatestRelease(repo: string): Promise<GitHubRelease | null> {
        const result = spawnSync("gh", ["release", "view", "--repo", repo, "--json", RELEASE_FIELDS], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.status !== 0) {
            if (/release not found|not found|HTTP 404/i.test(result.stderr)) return null;
            fail((result.stderr || `gh exited ${result.status}`).trim());
        }
        return parseGhRelease(result.stdout);
    }

    async isCommitOnMain(_repo: string, sha: string): Promise<boolean> {
        const result = spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { stdio: "ignore" });
        return result.status === 0;
    }

    async uploadAssets(repo: string, tag: string, paths: readonly string[]): Promise<void> {
        runGh(["release", "upload", tag, ...paths, "--repo", repo, "--clobber"]);
    }

    async downloadAsset(repo: string, tag: string, name: string, destination: string): Promise<void> {
        runGh(["release", "download", tag, "--repo", repo, "--pattern", name, "--dir", destination]);
    }

    async publishRelease(repo: string, tag: string, makeLatest: boolean): Promise<void> {
        runGh([
            "release",
            "edit",
            tag,
            "--repo",
            repo,
            "--draft=false",
            "--verify-tag",
            `--latest=${makeLatest ? "true" : "false"}`,
        ]);
    }
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) fail(`${name} is required`);
    return value;
}

function identityFromEnv(): ReleaseIdentity {
    const published = requiredEnv("RELEASE_PUBLISHED");
    if (published !== "true" && published !== "false") fail("RELEASE_PUBLISHED must be true or false");
    return {
        tag: validateTag(requiredEnv("TAG_NAME")),
        releaseId: validateReleaseId(requiredEnv("RELEASE_ID")),
        commitSha: validateCommitSha(requiredEnv("RELEASE_SHA")),
        published: published === "true",
    };
}

function writeOutputs(identity: ReleaseIdentity): void {
    const path = requiredEnv("GITHUB_OUTPUT");
    const state = identity.published ? "published" : "draft";
    writeFileSync(
        path,
        `tag_name=${identity.tag}\nrelease_id=${identity.releaseId}\nrelease_sha=${identity.commitSha}\npublished=${identity.published}\npublication_state=${state}\n`,
        { flag: "a" },
    );
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
    const [mode, directory] = args;
    const adapter = new GhCliAdapter();
    const repo = requiredEnv("GH_REPO");
    if (mode === "resolve") {
        const identity = await resolveRelease(adapter, {
            repo,
            tag: requiredEnv("TAG_NAME"),
            automaticSha: process.env.RELEASE_PLEASE_SHA || undefined,
        });
        writeOutputs(identity);
        return;
    }
    const identity = identityFromEnv();
    if (mode === "publish") {
        if (!directory) fail("publish mode requires an asset directory");
        await publishReleaseAssets(adapter, repo, identity, directory);
        writeOutputs({ ...identity, published: true });
        return;
    }
    if (mode === "verify") {
        await verifyPublishedRelease(adapter, repo, identity);
        writeOutputs({ ...identity, published: true });
        return;
    }
    fail("usage: bun scripts/release-artifacts.ts <resolve|publish|verify> [asset-directory]");
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`release artifact error: ${message}`);
        process.exitCode = 1;
    });
}
