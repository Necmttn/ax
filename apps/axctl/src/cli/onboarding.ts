import { Effect, FileSystem, Path } from "effect";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { orAbsent } from "@ax/lib/shared/fs-error";

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

const isGitTracked = (
    path: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Discovery probe: a missing/unreadable path is simply "not tracked".
        const exists = yield* fs.exists(path).pipe(orAbsent(false));
        if (!exists) return false;
        const root = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
        return root.status === 0 && root.stdout.trim().length > 0;
    });

const checkPath = (
    id: string,
    title: string,
    path: string,
    recommendation: string,
): Effect.Effect<OnboardingCheck, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const tracked = yield* isGitTracked(path);
        return {
            id,
            title,
            status: tracked ? "ok" : "warn",
            path,
            recommendation: tracked
                ? "Already inside a git-tracked guidance/config repository."
                : recommendation,
        };
    });

export const buildOnboardingReport = (
    home = homedir(),
): Effect.Effect<OnboardingReport, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const checks = [
            yield* checkPath(
                "claude-global",
                "Claude global guidance",
                path.join(home, ".claude"),
                "Track ~/.claude or move Claude guidance/hooks/commands into a dotfiles repo so guidance experiments have commit evidence.",
            ),
            yield* checkPath(
                "codex-global",
                "Codex global guidance",
                path.join(home, ".codex"),
                "Track ~/.codex or move Codex guidance/skills/config into a dotfiles repo so agent behavior changes can be compared over time.",
            ),
            yield* checkPath(
                "agents-shared",
                "Shared agent skills",
                path.join(home, ".agents"),
                "Track shared skills and hooks in git; axctl can then link global/local skill changes to later outcomes.",
            ),
        ];
        return { checks };
    });

export function formatOnboardingReport(report: OnboardingReport, json: boolean): string {
    if (json) return JSON.stringify(report, null, 2);
    return report.checks
        .map((check) => `${check.status === "ok" ? "✓" : "!"} ${check.title}\n  ${check.path}\n  ${check.recommendation}`)
        .join("\n\n");
}

export function formatInstallOnboardingGuidance(report: OnboardingReport): string | null {
    const warnings = report.checks.filter((check) => check.status === "warn");
    if (warnings.length === 0) {
        return "Harness tracking: ok. Global guidance directories are already inside git-tracked repositories.";
    }

    const lines = [
        "Harness tracking recommended",
        "",
        ...warnings.flatMap((check) => [
            `${check.title}: ${check.path}`,
            `  ${check.recommendation}`,
        ]),
        "",
        "Ask your host agent to:",
        "1. Run `axctl doctor --json` and use it as source of truth.",
        "2. For each warning, initialize or reuse a git repository for that harness directory.",
        "3. Add a conservative `.gitignore` that excludes transcripts, caches, logs, secrets, node_modules, and generated artifacts.",
        "4. Track guidance, hooks, skills, commands, and settings only.",
        "5. Commit the baseline with `chore: track agent harness`.",
        "6. Rerun `axctl doctor --json` and report remaining warnings.",
    ];

    return lines.join("\n");
}
