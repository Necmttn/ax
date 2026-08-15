import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { showExperiment, formatShow } from "./show.ts";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";

const layerWith = (found: boolean) => judgmentTestLayer((sql) => {
    if (sql.includes("FROM proposal WHERE") || sql.includes("FROM proposal\n")) return found ? [{
        id: "abc", dedupe_sig: "e7f3", title: "T", form: "guidance", hypothesis: "h",
        status: "accepted", confidence: "high", frequency: 3, origin: "agent",
        hypothesis_template: null, evidence_query: null, reject_reason: null, baseline: null,
        created_at: new Date("2026-05-20T00:00:00Z"), updated_at: new Date("2026-05-20T00:00:00Z"),
    }] : [];
    if (sql.includes("FROM guidance_proposal")) return found ? [{
        proposal: "abc", file_target: "CLAUDE.md", section: null, suggested_text: "text",
    }] : [];
    if (sql.includes("FROM experiment")) return found ? [{
        id: "exp", proposal: "abc", artifact: null, artifact_path: "/x/CLAUDE.md",
        scaffolded_at: new Date("2026-05-20T00:00:00Z"), created_at: new Date("2026-05-20T00:00:00Z"),
        locked_verdict: null, status: "scaffolded", task_path: null,
    }] : [];
    if (sql.includes("FROM checkpoint")) return found ? [{
        id: "cp", experiment: "exp", kind: "early", measured: { ratio: 0.5 },
        suggested: "adopted", user_verdict: null, observed_at: new Date("2026-05-25T00:00:00Z"),
    }] : [];
    return [];
});

describe("showExperiment", () => {
    test("returns null when nothing matches", async () => {
        const out = await Effect.runPromise(
            showExperiment({ sigOrId: "missing" })
                .pipe(Effect.provide(layerWith(false))),
        );
        expect(out).toBeNull();
    });

    test("returns proposal + experiment + checkpoints when found", async () => {
        const out = await Effect.runPromise(
            showExperiment({ sigOrId: "e7f3" })
                .pipe(Effect.provide(layerWith(true))),
        );
        expect(out?.proposal.shortId).toBe("e7f3");
        expect(out?.experiment?.id).toBe("exp");
        expect(out?.checkpoints).toHaveLength(1);
    });

    test("formatShow renders all sections", () => {
        const out = formatShow({
            proposal: {
                shortId: "e7f3", title: "T", form: "guidance", hypothesis: "h",
                status: "accepted", confidence: "high", frequency: 3,
                updatedAt: "2026-05-20T00:00:00Z",
                safety: null,
            },
            experiment: {
                id: "experiment:abc", status: "scaffolded",
                artifactPath: "/x/CLAUDE.md", taskPath: null, lockedVerdict: null,
            },
            checkpoints: [],
        });
        expect(out).toContain("e7f3");
        expect(out).toContain("scaffolded");
        expect(out).toContain("CLAUDE.md");
    });

    test("formatShow renders missing safety gates", () => {
        const out = formatShow({
            proposal: {
                shortId: "hook_sig", title: "Hook", form: "hook", hypothesis: "h",
                status: "open", confidence: "medium", frequency: 1,
                updatedAt: "2026-05-20T00:00:00Z",
                safety: {
                    recoveryPath: null,
                    smokeTestCommand: null,
                    disableCommand: null,
                    failureMode: null,
                },
            },
            experiment: null,
            checkpoints: [],
        });
        expect(out).toContain("Safety gates missing: Recovery Path, smoke test, disable switch, failure mode");
    });

    test("formatShow renders complete safety contract", () => {
        const out = formatShow({
            proposal: {
                shortId: "auto_sig", title: "Automation", form: "automation", hypothesis: "h",
                status: "open", confidence: "medium", frequency: 1,
                updatedAt: "2026-05-20T00:00:00Z",
                safety: {
                    recoveryPath: "Unload the LaunchAgent",
                    smokeTestCommand: "launchctl print gui/$UID/com.ax.weekly",
                    disableCommand: "launchctl unload ~/Library/LaunchAgents/com.ax.weekly.plist",
                    failureMode: "fail_open",
                },
            },
            experiment: null,
            checkpoints: [],
        });
        expect(out).toContain("automation proposal has complete safety gates; run ax improve accept to emit a manual task brief");
        expect(out).toContain("Recovery Path: Unload the LaunchAgent");
        expect(out).toContain("Failure Mode: fail_open");
    });
});
