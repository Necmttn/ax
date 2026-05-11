import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildOnboardingReport, formatOnboardingReport } from "./onboarding.ts";

describe("onboarding report", () => {
    test("warns when global guidance directories are not git tracked", async () => {
        const root = await mkdtemp(join(tmpdir(), "agentctl-onboarding-"));
        try {
            await mkdir(join(root, ".claude"));
            await mkdir(join(root, ".codex"));
            await mkdir(join(root, ".agents"));
            const report = buildOnboardingReport(root);

            expect(report.checks.every((check) => check.status === "warn")).toBe(true);
            expect(formatOnboardingReport(report, true)).toContain("claude-global");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("passes when guidance directories are inside a git repository", async () => {
        const root = await mkdtemp(join(tmpdir(), "agentctl-onboarding-"));
        try {
            spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
            await mkdir(join(root, ".claude"));
            await mkdir(join(root, ".codex"));
            await mkdir(join(root, ".agents"));
            const report = buildOnboardingReport(root);

            expect(report.checks.every((check) => check.status === "ok")).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
