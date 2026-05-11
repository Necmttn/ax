import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface OnboardingCheck {
    readonly id: string;
    readonly title: string;
    readonly status: "ok" | "warn";
    readonly path: string;
    readonly recommendation: string;
}

export interface OnboardingReport {
    readonly checks: readonly OnboardingCheck[];
}

function isGitTracked(path: string): boolean {
    if (!existsSync(path)) return false;
    const root = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    return root.status === 0 && root.stdout.trim().length > 0;
}

function checkPath(id: string, title: string, path: string, recommendation: string): OnboardingCheck {
    const tracked = isGitTracked(path);
    return {
        id,
        title,
        status: tracked ? "ok" : "warn",
        path,
        recommendation: tracked
            ? "Already inside a git-tracked guidance/config repository."
            : recommendation,
    };
}

export function buildOnboardingReport(home = homedir()): OnboardingReport {
    const checks = [
        checkPath(
            "claude-global",
            "Claude global guidance",
            join(home, ".claude"),
            "Track ~/.claude or move Claude guidance/hooks/commands into a dotfiles repo so guidance experiments have commit evidence.",
        ),
        checkPath(
            "codex-global",
            "Codex global guidance",
            join(home, ".codex"),
            "Track ~/.codex or move Codex guidance/skills/config into a dotfiles repo so agent behavior changes can be compared over time.",
        ),
        checkPath(
            "agents-shared",
            "Shared agent skills",
            join(home, ".agents"),
            "Track shared skills and hooks in git; agentctl can then link global/local skill changes to later outcomes.",
        ),
    ];
    return { checks };
}

export function formatOnboardingReport(report: OnboardingReport, json: boolean): string {
    if (json) return JSON.stringify(report, null, 2);
    return report.checks
        .map((check) => `${check.status === "ok" ? "✓" : "!"} ${check.title}\n  ${check.path}\n  ${check.recommendation}`)
        .join("\n\n");
}
