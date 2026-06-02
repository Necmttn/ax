import { describe, expect, test } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import {
    AX_VERSION,
    compareVersions,
    formatProvenance,
    formatVersionReport,
    formatVersionStatus,
    parseGitDescribe,
    resolveGitProvenance,
    updateAxctl,
    versionStatus,
    type GitProvenance,
    type ProvenanceDeps,
    type VersionDeps,
} from "./version.ts";

describe("cli version", () => {
    test("embedded version matches package.json", () => {
        expect(AX_VERSION).toBe(pkg.version);
    });

    test("compares v-prefixed semantic versions", () => {
        expect(compareVersions("0.1.1", "v0.1.1")).toBe(0);
        expect(compareVersions("0.1.1", "v0.1.2")).toBeLessThan(0);
        expect(compareVersions("0.2.0", "v0.1.9")).toBeGreaterThan(0);
    });

    test("reports update availability against latest release", () => {
        expect(versionStatus("0.1.1", {
            tagName: "v0.1.2",
            url: "https://github.com/Necmttn/ax/releases/tag/v0.1.2",
        })).toMatchObject({
            current: "0.1.1",
            latest: "v0.1.2",
            updateAvailable: true,
        });
        expect(formatVersionStatus(versionStatus("0.1.2", {
            tagName: "v0.1.2",
            url: null,
        }))).toContain("update: current");
    });

    test("update --check does not run installer", async () => {
        let installRuns = 0;
        const deps: VersionDeps = {
            fetchLatestRelease: async () => ({ tagName: "v9.0.0", url: null }),
            fetchInstallScript: async () => "exit 0",
            runInstallScript: async () => {
                installRuns += 1;
                return 0;
            },
        };

        await updateAxctl(["--check"], deps);
        expect(installRuns).toBe(0);
    });

    test("update runs latest release installer when newer release exists", async () => {
        let envVersion: string | undefined;
        const deps: VersionDeps = {
            fetchLatestRelease: async () => ({ tagName: "v9.0.0", url: null }),
            fetchInstallScript: async () => "install script",
            runInstallScript: async (_script, env) => {
                envVersion = env.AXCTL_VERSION;
                return 0;
            },
            env: {},
        };

        await updateAxctl([], deps);
        expect(envVersion).toBe("latest");
    });

    test("parses git describe forms (clean tag, ahead+dirty, untagged)", () => {
        expect(parseGitDescribe("v0.7.0-0-gfa3cf80")).toEqual({
            tag: "v0.7.0",
            commitsAhead: 0,
            sha: "fa3cf80",
            dirty: false,
        });
        expect(parseGitDescribe("v0.7.0-9-gfa3cf80-dirty")).toEqual({
            tag: "v0.7.0",
            commitsAhead: 9,
            sha: "fa3cf80",
            dirty: true,
        });
        expect(parseGitDescribe("fa3cf80")).toEqual({
            tag: null,
            commitsAhead: 0,
            sha: "fa3cf80",
            dirty: false,
        });
    });

    test("resolveGitProvenance prefers live git, falls back to baked, else null", () => {
        const liveDeps: ProvenanceDeps = {
            runGit: (args) =>
                args[0] === "describe" ? "v0.7.0-9-gfa3cf80-dirty" : "main",
            bakedDescribe: "v9.9.9-0-gdeadbee",
        };
        expect(resolveGitProvenance(liveDeps)).toMatchObject({
            tag: "v0.7.0",
            commitsAhead: 9,
            sha: "fa3cf80",
            dirty: true,
            branch: "main",
            source: "git",
        });

        const bakedDeps: ProvenanceDeps = {
            runGit: () => null,
            bakedDescribe: "v0.7.0-0-gfa3cf80",
        };
        expect(resolveGitProvenance(bakedDeps)).toMatchObject({
            tag: "v0.7.0",
            commitsAhead: 0,
            branch: null,
            source: "baked",
        });

        expect(resolveGitProvenance({ runGit: () => null, bakedDescribe: "" })).toBeNull();
    });

    test("formatProvenance renders a verdict for clean vs ahead/dirty vs baked", () => {
        const clean: GitProvenance = {
            describe: "v0.7.0-0-gfa3cf80",
            tag: "v0.7.0",
            sha: "fa3cf80",
            commitsAhead: 0,
            dirty: false,
            branch: "main",
            source: "git",
        };
        expect(formatProvenance(clean).join("\n")).toContain("release tag v0.7.0");
        expect(formatProvenance(clean).join("\n")).toContain("branch: main");

        const ahead: GitProvenance = { ...clean, commitsAhead: 9, dirty: true, describe: "v0.7.0-9-gfa3cf80-dirty" };
        const aheadOut = formatProvenance(ahead).join("\n");
        expect(aheadOut).toContain("v0.7.0+9");
        expect(aheadOut).toContain("dirty");
        expect(aheadOut).toContain("ahead of release tag v0.7.0");

        const baked: GitProvenance = { ...clean, branch: null, source: "baked" };
        expect(formatProvenance(baked).join("\n")).toContain("source: compiled binary");
        expect(formatProvenance(null)).toEqual([]);
    });

    test("formatVersionReport hides 'latest: unknown' on bare -v, shows it when checked", () => {
        const prov: GitProvenance = {
            describe: "v0.7.0-0-gfa3cf80",
            tag: "v0.7.0",
            sha: "fa3cf80",
            commitsAhead: 0,
            dirty: false,
            branch: "main",
            source: "git",
        };
        const status = versionStatus("0.7.0", null);
        const bare = formatVersionReport(status, prov, { checked: false });
        expect(bare).toContain("build: v0.7.0");
        expect(bare).not.toContain("latest: unknown");
        expect(bare).toContain("ax -v --check");

        const checked = formatVersionReport(
            versionStatus("0.7.0", { tagName: "v0.8.0", url: null }),
            prov,
            { checked: true },
        );
        expect(checked).toContain("latest: v0.8.0");
        expect(checked).toContain("update: available");
    });
});
