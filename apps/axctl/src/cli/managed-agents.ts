import { Effect, FileSystem } from "effect";
import { posixPath } from "@ax/lib/shared/path";
import retroReviewerAgent from "../../../../agents/retro-reviewer.md" with { type: "text" };

export const AX_AGENT_OWNERSHIP_MARKER = "<!-- managed by ax -->";
export const RETRO_REVIEWER_AGENT_TEMPLATE = retroReviewerAgent;

export const provisionRetroReviewerAgent = Effect.fn(
    "cli.provisionRetroReviewerAgent",
)(function* (agentsDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const target = posixPath.join(agentsDir, "retro-reviewer.md");
    yield* fs.makeDirectory(agentsDir, { recursive: true });

    if (yield* fs.exists(target)) {
        const existing = yield* fs.readFileString(target);
        if (!existing.includes(AX_AGENT_OWNERSHIP_MARKER)) {
            return { path: target, status: "skipped_user_owned" } as const;
        }
        if (existing !== RETRO_REVIEWER_AGENT_TEMPLATE) {
            yield* fs.writeFileString(target, RETRO_REVIEWER_AGENT_TEMPLATE);
            return { path: target, status: "updated" } as const;
        }
        return { path: target, status: "unchanged" } as const;
    }

    yield* fs.writeFileString(target, RETRO_REVIEWER_AGENT_TEMPLATE);
    return { path: target, status: "installed" } as const;
});
