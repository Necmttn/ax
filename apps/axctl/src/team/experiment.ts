const KINDS = new Set(["skill", "agent", "hook"]);
const NAME_RE = /^[a-zA-Z0-9._-]+$/;

export const isSafeKindName = (kind: string, name: string): boolean =>
  KINDS.has(kind) && NAME_RE.test(name) && name !== "." && name !== "..";

const sub = (kind: string) =>
  kind === "skill" ? "skills" : kind === "agent" ? "agents" : "hooks";

const ext = (kind: string) => (kind === "agent" ? "md" : "ts");

const rel = (kind: string, name: string) =>
  kind === "skill" ? name : `${name}.${ext(kind)}`;

export const overlayPath = (root: string, kind: string, name: string) =>
  `${root}/.ax.local/${sub(kind)}/${rel(kind, name)}`;

export const committedPath = (root: string, kind: string, name: string) =>
  `${root}/.ax/${sub(kind)}/${rel(kind, name)}`;

const guard = (kind: string, name: string) => {
  if (!isSafeKindName(kind, name))
    throw new Error(`unsafe experiment kind/name: ${kind}/${name}`);
};

const scaffold = (kind: string, name: string): string =>
  kind === "hook"
    ? `import { defineHook } from "@ax/hooks-sdk/define";\nexport default defineHook({ name: "${name}", events: [], run: () => ({ _tag: "Allow" }) });\n`
    : `---\nname: ${name}\ndescription: TODO\n---\n`;

/** Copy the committed artifact into the overlay for editing, or scaffold a new one. */
export async function startExperiment(
  root: string,
  kind: string,
  name: string,
): Promise<string> {
  guard(kind, name);
  const dst = overlayPath(root, kind, name);
  const src = committedPath(root, kind, name);
  if (kind === "skill") {
    Bun.spawnSync(["mkdir", "-p", `${root}/.ax.local/skills`]);
    if (Bun.spawnSync(["test", "-d", src]).exitCode === 0) {
      Bun.spawnSync(["rm", "-rf", dst]);
      Bun.spawnSync(["cp", "-R", src, dst]);
    } else {
      await Bun.write(`${dst}/SKILL.md`, scaffold(kind, name), {
        createPath: true,
      });
    }
  } else {
    const exists = await Bun.file(src).exists();
    const content = exists ? await Bun.file(src).text() : scaffold(kind, name);
    await Bun.write(dst, content, { createPath: true });
  }
  return dst;
}

/** Move the overlay artifact into the committed rig; clear the overlay copy. */
export async function promoteExperiment(
  root: string,
  kind: string,
  name: string,
): Promise<string> {
  guard(kind, name);
  const src = overlayPath(root, kind, name);
  const dst = committedPath(root, kind, name);
  // Verify the overlay source exists BEFORE touching the committed target -
  // otherwise a typo'd name would rm -rf the committed artifact then fail the cp.
  if (Bun.spawnSync(["test", "-e", src]).exitCode !== 0)
    throw new Error(`promote ${kind}/${name}: no overlay at ${src} (run \`ax team experiment start ${kind} ${name}\` first)`);
  Bun.spawnSync(["mkdir", "-p", `${root}/.ax/${sub(kind)}`]);
  Bun.spawnSync(["rm", "-rf", dst]);
  const r = Bun.spawnSync(["cp", "-R", src, dst]);
  if (r.exitCode !== 0)
    throw new Error(`promote ${kind}/${name}: cp failed (${r.exitCode})`);
  Bun.spawnSync(["rm", "-rf", src]);
  return dst;
}

/** Discard the overlay artifact. */
export async function dropExperiment(
  root: string,
  kind: string,
  name: string,
): Promise<void> {
  guard(kind, name);
  Bun.spawnSync(["rm", "-rf", overlayPath(root, kind, name)]);
}
