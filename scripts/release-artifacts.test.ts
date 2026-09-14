import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { formatVersionReport, versionStatus, type GitProvenance } from "../apps/axctl/src/cli/version.ts";
import {
    ARCHIVE_NAMES,
    ASSET_NAMES,
    type GitHubAdapter,
    type GitHubRelease,
    type ReleaseIdentity,
    prepareLocalAssets,
    publishReleaseAssets,
    resolveRelease,
    validateCommitSha,
    validateTag,
    verifyDownloadedAssets,
    verifyPublishedRelease,
} from "./release-artifacts.ts";

const repo = "Necmttn/ax";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const directories: string[] = [];

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "ax-release-test-"));
    directories.push(directory);
    return directory;
}

function makeArchives(directory = temporaryDirectory()): string {
    for (const [index, name] of ARCHIVE_NAMES.entries()) {
        writeFileSync(join(directory, name), `archive-${index}`);
    }
    return directory;
}

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class MemoryGitHub implements GitHubAdapter {
    release: GitHubRelease | null = {
        id: "1152",
        tagName: "v1.2.3",
        targetCommitish: sha,
        isDraft: true,
        isPrerelease: false,
        assets: [],
    };
    tagCommit: string | null = sha;
    latest: GitHubRelease | null = {
        id: "1000",
        tagName: "v1.2.2",
        targetCommitish: otherSha,
        isDraft: false,
        isPrerelease: false,
        assets: [],
    };
    onMain = true;
    calls: string[] = [];
    files = new Map<string, Uint8Array>();
    failUpload = false;
    failDownloadAt = 0;
    corruptChecksum = false;
    substituteRemoteSet = false;
    moveTagAfterDownloads = 0;
    downloads = 0;

    async getRelease(_repo: string, tag: string): Promise<GitHubRelease | null> {
        this.calls.push(`get-release:${tag}`);
        if (!this.release) return null;
        return { ...this.release, assets: [...this.release.assets] };
    }

    async getTagCommit(_repo: string, tag: string): Promise<string | null> {
        this.calls.push(`get-tag:${tag}`);
        return this.tagCommit;
    }

    async getLatestRelease(): Promise<GitHubRelease | null> {
        this.calls.push("get-latest");
        return this.latest;
    }

    async isCommitOnMain(): Promise<boolean> {
        this.calls.push("check-main");
        return this.onMain;
    }

    async uploadAssets(_repo: string, tag: string, paths: readonly string[]): Promise<void> {
        this.calls.push(`upload:${tag}`);
        if (this.failUpload) throw new Error("injected upload failure");
        for (const path of paths) this.files.set(path.split("/").at(-1)!, readFileSync(path));
        if (this.substituteRemoteSet) {
            const replacement = makeArchives();
            for (const name of ARCHIVE_NAMES) writeFileSync(join(replacement, name), `substitute-${name}`);
            for (const path of prepareLocalAssets(replacement)) {
                this.files.set(path.split("/").at(-1)!, readFileSync(path));
            }
        }
        this.release = {
            ...this.release!,
            assets: [...this.files].map(([name, bytes]) => ({ name, size: bytes.byteLength })),
        };
    }

    async downloadAsset(_repo: string, tag: string, name: string, destination: string): Promise<void> {
        this.downloads += 1;
        this.calls.push(`download:${name}`);
        if (this.failDownloadAt === this.downloads) throw new Error("injected download failure");
        const bytes = this.files.get(name);
        if (!bytes) throw new Error(`missing remote asset ${name}`);
        const value = this.corruptChecksum && name === "checksums.txt" ? new TextEncoder().encode("bad\n") : bytes;
        writeFileSync(join(destination, name), value);
        if (this.moveTagAfterDownloads === this.downloads) this.tagCommit = otherSha;
    }

    async publishRelease(_repo: string, tag: string, makeLatest: boolean): Promise<void> {
        this.calls.push(`publish:${tag}:${makeLatest}`);
        this.release = { ...this.release!, isDraft: false };
        if (makeLatest) this.latest = this.release;
    }
}

const identity: ReleaseIdentity = {
    tag: "v1.2.3",
    releaseId: "1152",
    commitSha: sha,
    published: false,
};

async function seedRemote(adapter: MemoryGitHub): Promise<void> {
    const directory = makeArchives();
    await adapter.uploadAssets(repo, identity.tag, prepareLocalAssets(directory));
    adapter.calls.length = 0;
    adapter.downloads = 0;
}

describe("release identity validation", () => {
    test("accepts stable tags and full commit identifiers only", () => {
        expect(validateTag("v0.44.3")).toBe("v0.44.3");
        expect(validateCommitSha(sha)).toBe(sha);
        for (const tag of ["0.44.3", "v1.2", "v1.2.3-rc.1", "v01.2.3"]) {
            expect(() => validateTag(tag)).toThrow();
        }
        expect(() => validateCommitSha("main")).toThrow("full 40-character SHA");
    });

    test("resolves an automatic draft from matching independent sources", async () => {
        const adapter = new MemoryGitHub();
        await expect(resolveRelease(adapter, { repo, tag: "v1.2.3", automaticSha: sha })).resolves.toEqual(identity);
        expect(adapter.calls).toEqual(["get-release:v1.2.3", "get-tag:v1.2.3", "check-main"]);
    });

    test("resolves manual drafts and published retries", async () => {
        const draftAdapter = new MemoryGitHub();
        await expect(resolveRelease(draftAdapter, { repo, tag: "v1.2.3" })).resolves.toMatchObject({
            published: false,
        });
        draftAdapter.release = { ...draftAdapter.release!, isDraft: false };
        await expect(resolveRelease(draftAdapter, { repo, tag: "v1.2.3" })).resolves.toMatchObject({
            published: true,
        });
    });

    test("rejects missing releases, branch targets, moved tags, output drift, and commits outside main", async () => {
        const cases: Array<(adapter: MemoryGitHub) => void> = [
            (adapter) => (adapter.release = null),
            (adapter) => (adapter.release = { ...adapter.release!, targetCommitish: "main" }),
            (adapter) => (adapter.tagCommit = otherSha),
            (adapter) => (adapter.onMain = false),
        ];
        for (const arrange of cases) {
            const adapter = new MemoryGitHub();
            arrange(adapter);
            await expect(resolveRelease(adapter, { repo, tag: "v1.2.3", automaticSha: sha })).rejects.toThrow();
        }
        const adapter = new MemoryGitHub();
        await expect(resolveRelease(adapter, { repo, tag: "v1.2.3", automaticSha: otherSha })).rejects.toThrow(
            "release-please reported a different commit",
        );
    });
});

describe("release asset validation", () => {
    test("creates deterministic checksums for exactly three nonempty archives", () => {
        const directory = makeArchives();
        const paths = prepareLocalAssets(directory);
        expect(paths.map((path) => path.split("/").at(-1))).toEqual(ASSET_NAMES);
        expect(() => verifyDownloadedAssets(directory)).not.toThrow();
    });

    test("rejects a missing, extra, or empty archive", () => {
        const missing = makeArchives();
        rmSync(join(missing, ARCHIVE_NAMES[0]));
        expect(() => prepareLocalAssets(missing)).toThrow("archive names differ");

        const extra = makeArchives();
        writeFileSync(join(extra, "axctl-other.tar.gz"), "extra");
        expect(() => prepareLocalAssets(extra)).toThrow("archive names differ");

        const empty = makeArchives();
        writeFileSync(join(empty, ARCHIVE_NAMES[1]), "");
        expect(() => prepareLocalAssets(empty)).toThrow("asset is empty");
    });

    test("rejects changed archives, invalid checksum content, and extra downloads", () => {
        const changed = makeArchives();
        prepareLocalAssets(changed);
        writeFileSync(join(changed, ARCHIVE_NAMES[0]), "changed");
        expect(() => verifyDownloadedAssets(changed)).toThrow("checksum failed");

        const invalid = makeArchives();
        prepareLocalAssets(invalid);
        writeFileSync(join(invalid, "checksums.txt"), "bad\n");
        expect(() => verifyDownloadedAssets(invalid)).toThrow("exactly three entries");

        const extra = makeArchives();
        prepareLocalAssets(extra);
        mkdirSync(join(extra, "unexpected"));
        expect(() => verifyDownloadedAssets(extra)).toThrow("asset names differ");
    });

    test("accepts legacy ./ checksum paths and rejects normalized duplicates", () => {
        const legacy = makeArchives();
        prepareLocalAssets(legacy);
        const checksumPath = join(legacy, "checksums.txt");
        const canonical = readFileSync(checksumPath, "utf8");
        writeFileSync(checksumPath, canonical.replaceAll("  axctl-", "  ./axctl-"));
        expect(() => verifyDownloadedAssets(legacy)).not.toThrow();

        const duplicate = makeArchives();
        prepareLocalAssets(duplicate);
        const lines = readFileSync(join(duplicate, "checksums.txt"), "utf8").trimEnd().split("\n");
        writeFileSync(join(duplicate, "checksums.txt"), `${lines[0]}\n${lines[0]!.replace("  ", "  ./")}\n${lines[2]}\n`);
        expect(() => verifyDownloadedAssets(duplicate)).toThrow("invalid or duplicate entries");
    });
});

describe("draft publication", () => {
    test("publishes only after every uploaded asset is downloaded and verified", async () => {
        const adapter = new MemoryGitHub();
        await publishReleaseAssets(adapter, repo, identity, makeArchives());
        expect(adapter.release?.isDraft).toBe(false);
        const publishIndex = adapter.calls.indexOf("publish:v1.2.3:true");
        expect(publishIndex).toBeGreaterThan(adapter.calls.indexOf("download:checksums.txt"));
        expect(adapter.calls.slice(publishIndex - 3, publishIndex)).toEqual([
            "get-release:v1.2.3",
            "get-tag:v1.2.3",
            "get-latest",
        ]);
    });

    test("keeps the draft and latest release unchanged after upload failure", async () => {
        const adapter = new MemoryGitHub();
        adapter.failUpload = true;
        const latest = adapter.latest;
        await expect(publishReleaseAssets(adapter, repo, identity, makeArchives())).rejects.toThrow(
            "injected upload failure",
        );
        expect(adapter.release?.isDraft).toBe(true);
        expect(adapter.latest).toBe(latest);
        expect(adapter.calls.some((call) => call.startsWith("publish:"))).toBe(false);
    });

    test("keeps the draft after each possible download failure", async () => {
        for (let failure = 1; failure <= ASSET_NAMES.length; failure += 1) {
            const adapter = new MemoryGitHub();
            adapter.failDownloadAt = failure;
            await expect(publishReleaseAssets(adapter, repo, identity, makeArchives())).rejects.toThrow(
                "injected download failure",
            );
            expect(adapter.release?.isDraft).toBe(true);
            expect(adapter.calls.some((call) => call.startsWith("publish:"))).toBe(false);
        }
    });

    test("keeps the draft after downloaded checksum verification fails", async () => {
        const adapter = new MemoryGitHub();
        adapter.corruptChecksum = true;
        await expect(publishReleaseAssets(adapter, repo, identity, makeArchives())).rejects.toThrow();
        expect(adapter.release?.isDraft).toBe(true);
        expect(adapter.calls.some((call) => call.startsWith("publish:"))).toBe(false);
    });

    test("rejects a remote set that is self-consistent but differs from the staged build", async () => {
        const adapter = new MemoryGitHub();
        adapter.substituteRemoteSet = true;
        await expect(publishReleaseAssets(adapter, repo, identity, makeArchives())).rejects.toThrow(
            "differs from staged asset",
        );
        expect(adapter.release?.isDraft).toBe(true);
        expect(adapter.calls.some((call) => call.startsWith("publish:"))).toBe(false);
    });

    test("rejects a tag moved during downloads", async () => {
        const adapter = new MemoryGitHub();
        adapter.moveTagAfterDownloads = ASSET_NAMES.length;
        await expect(publishReleaseAssets(adapter, repo, identity, makeArchives())).rejects.toThrow(
            "does not point",
        );
        expect(adapter.release?.isDraft).toBe(true);
    });

    test("replaces partial expected draft assets and reports unexpected assets", async () => {
        const adapter = new MemoryGitHub();
        adapter.release = {
            ...adapter.release!,
            assets: [{ name: ARCHIVE_NAMES[0], size: 4 }],
        };
        adapter.files.set(ARCHIVE_NAMES[0], new TextEncoder().encode("old"));
        await expect(publishReleaseAssets(adapter, repo, identity, makeArchives())).resolves.toBeUndefined();

        const unexpected = new MemoryGitHub();
        unexpected.release = { ...unexpected.release!, assets: [{ name: "unknown.bin", size: 1 }] };
        await expect(publishReleaseAssets(unexpected, repo, identity, makeArchives())).rejects.toThrow(
            "unexpected assets",
        );
        expect(unexpected.calls.some((call) => call.startsWith("upload:"))).toBe(false);
    });

    test("does not replace a newer latest release when older work completes later", async () => {
        const older = new MemoryGitHub();
        older.release = { ...older.release!, tagName: "v1.2.1" };
        older.latest = { ...older.latest!, tagName: "v1.2.2" };
        const olderIdentity = { ...identity, tag: "v1.2.1" };
        await publishReleaseAssets(older, repo, olderIdentity, makeArchives());
        expect(older.calls).toContain("publish:v1.2.1:false");
        expect(older.latest?.tagName).toBe("v1.2.2");
    });
});

describe("published retry", () => {
    test("verifies complete remote files without upload or publication", async () => {
        const adapter = new MemoryGitHub();
        await seedRemote(adapter);
        adapter.release = { ...adapter.release!, isDraft: false };
        await verifyPublishedRelease(adapter, repo, { ...identity, published: true });
        expect(adapter.calls.filter((call) => call.startsWith("download:"))).toHaveLength(ASSET_NAMES.length);
        expect(adapter.calls.some((call) => call.startsWith("upload:") || call.startsWith("publish:"))).toBe(false);
    });

    test("rejects an incomplete published release without mutation", async () => {
        const adapter = new MemoryGitHub();
        adapter.release = { ...adapter.release!, isDraft: false };
        await expect(verifyPublishedRelease(adapter, repo, { ...identity, published: true })).rejects.toThrow();
        expect(adapter.calls.some((call) => call.startsWith("upload:") || call.startsWith("publish:"))).toBe(false);
    });
});

describe("release workflow structure", () => {
    const workflow = parse(
        readFileSync(join(import.meta.dir, "..", ".github/workflows/release-please.yml"), "utf8"),
    ) as { on: Record<string, unknown>; jobs: Record<string, any> };
    const jobs = workflow.jobs;

    test("configures release-please to create a tag and a draft", () => {
        const config = JSON.parse(
            readFileSync(join(import.meta.dir, "..", "release-please-config.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(config.draft).toBe(true);
        expect(config["force-tag-creation"]).toBe(true);
    });

    test("has one draft-based publication path with immutable source outputs", () => {
        expect(workflow.on.release).toBeUndefined();
        expect(jobs["release-please"].outputs.sha).toContain("steps.release.outputs.sha");
        expect(jobs["resolve-release"].needs).toEqual(["validate-dispatch", "release-please"]);
        expect(jobs["resolve-release"].if).toContain("releases_created");
        expect(jobs["resolve-release"].if).toContain("inputs.tag_name != ''");
        expect(jobs["build-artifacts"].needs).toBe("resolve-release");
        expect(jobs["build-artifacts"].if).toContain("published == 'false'");
    });

    test("checks out the resolved source and checks tag and binary versions", () => {
        const build = jobs["build-artifacts"];
        const checkout = build.steps.find((step: any) => step.uses === "actions/checkout@v4");
        expect(checkout.with.ref).toContain("needs.resolve-release.outputs.release_sha");
        expect(checkout.with["fetch-depth"]).toBe(0);
        const text = JSON.stringify(build.steps);
        expect(text).toContain("git rev-parse HEAD");
        expect(text).toContain("git rev-list -n 1");
        expect(text).toContain("axctl ${TAG_NAME#v}");
        expect(text).toContain("version_output%%");
        expect(text).toContain("source: compiled binary");
        expect(text).toContain("release tag $TAG_NAME");
        expect(text).not.toContain('test \"$(./dist/axctl --version)\" = \"${TAG_NAME#v}\"');
    });

    test("accepts the real multiline compiled version report", () => {
        const provenance: GitProvenance = {
            describe: "v1.2.3-0-gabc1234",
            tag: "v1.2.3",
            sha: "abc1234",
            commitsAhead: 0,
            dirty: false,
            branch: null,
            source: "baked",
        };
        const output = formatVersionReport(versionStatus("1.2.3", null), provenance, { checked: false });
        expect(output.split("\n")[0]).toBe("axctl 1.2.3");
        expect(output).toMatch(/^build: v1\.2\.3 \(g[0-9a-f]+\) - release tag v1\.2\.3$/m);
        expect(output).toMatch(/^source: compiled binary$/m);
        expect(output).not.toBe("1.2.3");
    });

    test("requires successful builds and serializes every publication", () => {
        const publish = jobs["publish-artifacts"];
        expect(publish.needs).toEqual(["resolve-release", "build-artifacts"]);
        expect(publish.if).toContain("needs.build-artifacts.result == 'success'");
        expect(publish.concurrency).toEqual({
            group: "release-publication",
            "cancel-in-progress": false,
            queue: "max",
        });
    });

    test("uses separate draft publication and published verification branches", () => {
        const steps = jobs["publish-artifacts"].steps;
        const publish = steps.find((step: any) => step.run?.includes("release-artifacts.ts publish"));
        const verify = steps.find((step: any) => step.run?.includes("release-artifacts.ts verify"));
        expect(publish.if).toContain("published == 'false'");
        expect(verify.if).toContain("published == 'true'");
        expect(JSON.stringify(verify)).not.toContain("upload");
    });

    test("rejects manual dispatches outside main before release work", () => {
        const validate = jobs["validate-dispatch"];
        expect(JSON.stringify(validate)).toContain("refs/heads/main");
        expect(jobs["release-please"].needs).toBe("validate-dispatch");
        expect(jobs["resolve-release"].if).toContain("needs.validate-dispatch.result == 'success'");
    });
});
