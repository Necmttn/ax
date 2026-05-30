import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { showExperiment, formatShow } from "./show.ts";
import { SurrealClient } from "../lib/db.ts";

const layerWith = (...fixtures: unknown[][]) => {
    let i = 0;
    return Layer.succeed(SurrealClient, {
        query: <T>(_: string) => Effect.succeed([(fixtures[i++] ?? [])] as unknown as T),
    } as never);
};

describe("showExperiment", () => {
    test("returns null when nothing matches", async () => {
        const out = await Effect.runPromise(
            showExperiment({ sigOrId: "missing" })
                .pipe(Effect.provide(layerWith([], [], []))),
        );
        expect(out).toBeNull();
    });

    test("returns proposal + experiment + checkpoints when found", async () => {
        const out = await Effect.runPromise(
            showExperiment({ sigOrId: "e7f3" })
                .pipe(Effect.provide(layerWith(
                    [{ dedupe_sig: "e7f3", title: "T", form: "guidance", hypothesis: "h",
                        status: "accepted", confidence: "high", frequency: 3,
                        updated_at: "2026-05-20T00:00:00Z", hook_payload: null, automation_payload: null }],
                    [{ id: "experiment:abc", status: "scaffolded",
                        artifact_path: "/x/CLAUDE.md", task_path: null, locked_verdict: null }],
                    [{ kind: "early", observed_at: "2026-05-25T00:00:00Z",
                        measured: { ratio: 0.5 }, suggested: "adopted", user_verdict: null }],
                ))),
        );
        expect(out?.proposal.shortId).toBe("e7f3");
        expect(out?.experiment?.id).toBe("experiment:abc");
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
