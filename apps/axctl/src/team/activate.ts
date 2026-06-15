import type { TeamArtifact } from "./model.ts";

/** Returns true for names that are safe slugs (no path separators or traversal). */
export const isSafeName = (name: string): boolean =>
  name !== ".." && /^[a-zA-Z0-9._-]+$/.test(name);

export const runtimeTarget = (a: TeamArtifact, home: string): string =>
  a.kind === "skill"
    ? `${home}/.claude/skills/${a.name}`
    : `${home}/.claude/agents/${a.name}.md`;

/** Copy an artifact's source into its runtime target (idempotent overwrite).
 *  Non-executable only (skills/agents) - hooks are gated upstream, never reach here. */
export async function activateArtifact(a: TeamArtifact, home: string): Promise<void> {
  if (!isSafeName(a.name)) throw new Error(`unsafe artifact name: ${JSON.stringify(a.name)}`);

  const target = runtimeTarget(a, home);

  if (a.kind === "agent") {
    const text = await Bun.file(a.path).text();
    await Bun.write(target, text, { createPath: true });
    return;
  }

  // skill: cp -R src → target (idempotent overwrite via rm + cp)
  Bun.spawnSync(["mkdir", "-p", `${home}/.claude/skills`]);
  Bun.spawnSync(["rm", "-rf", target]);
  const r = Bun.spawnSync(["cp", "-R", a.path, target]);
  if (r.exitCode !== 0) throw new Error(`activate ${a.name}: cp failed (${r.exitCode})`);
}
