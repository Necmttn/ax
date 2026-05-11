import { describe, expect, test } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import {
    AGENTCTL_VERSION,
    compareVersions,
    formatVersionStatus,
    updateAgentctl,
    versionStatus,
    type VersionDeps,
} from "./version.ts";

describe("cli version", () => {
    test("embedded version matches package.json", () => {
        expect(AGENTCTL_VERSION).toBe(pkg.version);
    });

    test("compares v-prefixed semantic versions", () => {
        expect(compareVersions("0.1.1", "v0.1.1")).toBe(0);
        expect(compareVersions("0.1.1", "v0.1.2")).toBeLessThan(0);
        expect(compareVersions("0.2.0", "v0.1.9")).toBeGreaterThan(0);
    });

    test("reports update availability against latest release", () => {
        expect(versionStatus("0.1.1", {
            tagName: "v0.1.2",
            url: "https://github.com/Necmttn/agentctl/releases/tag/v0.1.2",
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

        await updateAgentctl(["--check"], deps);
        expect(installRuns).toBe(0);
    });

    test("update runs latest release installer when newer release exists", async () => {
        let envVersion: string | undefined;
        const deps: VersionDeps = {
            fetchLatestRelease: async () => ({ tagName: "v9.0.0", url: null }),
            fetchInstallScript: async () => "install script",
            runInstallScript: async (_script, env) => {
                envVersion = env.AGENTCTL_VERSION;
                return 0;
            },
            env: {},
        };

        await updateAgentctl([], deps);
        expect(envVersion).toBe("latest");
    });
});
