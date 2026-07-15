import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
    AX_AGENT_OWNERSHIP_MARKER,
    provisionRetroReviewerAgent,
    RETRO_REVIEWER_AGENT_TEMPLATE,
} from "./managed-agents.ts";

const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const provision = (agentsDir: string) =>
    Effect.runPromise(
        provisionRetroReviewerAgent(agentsDir).pipe(Effect.provide(BunFsLayer)),
    );

describe("provisionRetroReviewerAgent", () => {
    it("creates a missing agents directory and installs the ax-managed template", async () => {
        const home = await mkdtemp(join(tmpdir(), "ax-managed-agents-"));
        const agentsDir = join(home, ".claude", "agents");

        const result = await provision(agentsDir);
        const installed = await readFile(join(agentsDir, "retro-reviewer.md"), "utf8");

        expect(result.status).toBe("installed");
        expect(installed).toContain(AX_AGENT_OWNERSHIP_MARKER);
        expect(installed).toContain("name: retro-reviewer");
    });

    it("never clobbers an existing user-authored reviewer", async () => {
        const home = await mkdtemp(join(tmpdir(), "ax-managed-agents-"));
        const agentsDir = join(home, ".claude", "agents");
        const target = join(agentsDir, "retro-reviewer.md");
        const userTemplate = "---\nname: retro-reviewer\n---\nmy private reviewer\n";
        await mkdir(agentsDir, { recursive: true });
        await writeFile(target, userTemplate);

        const result = await provision(agentsDir);

        expect(result.status).toBe("skipped_user_owned");
        expect(await readFile(target, "utf8")).toBe(userTemplate);
    });

    it("updates only an ax-managed reviewer and is idempotent once current", async () => {
        const home = await mkdtemp(join(tmpdir(), "ax-managed-agents-"));
        const agentsDir = join(home, ".claude", "agents");
        const target = join(agentsDir, "retro-reviewer.md");
        await mkdir(agentsDir, { recursive: true });
        await writeFile(target, `${AX_AGENT_OWNERSHIP_MARKER}\nstale template\n`);

        const updated = await provision(agentsDir);
        const unchanged = await provision(agentsDir);

        expect(updated.status).toBe("updated");
        expect(await readFile(target, "utf8")).toBe(RETRO_REVIEWER_AGENT_TEMPLATE);
        expect(unchanged.status).toBe("unchanged");
    });
});
