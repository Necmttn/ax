import { Glob } from "bun";
import type { GatedArtifact, TeamArtifact } from "./model.ts";

export interface ScanResult {
  readonly artifacts: ReadonlyArray<TeamArtifact>;
  readonly gated: ReadonlyArray<GatedArtifact>;
}

/** Returns true if `path` is an existing directory (no node:fs). */
const dirExists = (path: string): boolean =>
  Bun.spawnSync(["test", "-d", path]).exitCode === 0;

/** Scan `<repoRoot>/<subdir>/` for the team rig. Skills = each `skills/<name>/SKILL.md`
 *  (+ sibling files); agents = each `agents/<name>.md`; hooks = `hooks/*` (gated).
 *  `subdir` defaults to `.ax`; pass `.ax.local` for the overlay scan. */
export const scanAxFolder = async (repoRoot: string, subdir = ".ax"): Promise<ScanResult> => {
  const ax = `${repoRoot}/${subdir}`;
  if (!dirExists(ax)) return { artifacts: [], gated: [] };

  const artifacts: TeamArtifact[] = [];
  const gated: GatedArtifact[] = [];

  for await (const rel of new Glob("skills/*/SKILL.md").scan({ cwd: ax, onlyFiles: true })) {
    const name = rel.split("/")[1]!;
    const dir = `${ax}/skills/${name}`;
    const files: string[] = [];
    for await (const f of new Glob("**/*").scan({ cwd: dir, onlyFiles: true })) files.push(f);
    artifacts.push({ kind: "skill", name, path: dir, files });
  }
  for await (const rel of new Glob("agents/*.md").scan({ cwd: ax, onlyFiles: true })) {
    const name = rel.slice("agents/".length, -".md".length);
    artifacts.push({ kind: "agent", name, path: `${ax}/${rel}`, files: [`${name}.md`] });
  }
  for await (const rel of new Glob("hooks/*").scan({ cwd: ax, onlyFiles: true })) {
    const name = rel.slice("hooks/".length).replace(/\.[^.]+$/, "");
    gated.push({ kind: "hook", name, path: `${ax}/${rel}` });
  }
  return {
    artifacts: artifacts.sort((a, b) => a.name.localeCompare(b.name)),
    gated: gated.sort((a, b) => a.name.localeCompare(b.name)),
  };
};
