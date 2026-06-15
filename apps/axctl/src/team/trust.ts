import { decodeJsonOrNull } from "@ax/lib/decode";
import { artifactKey, type SyncClassification, type TeamArtifact, type TrustState } from "./model.ts";

export const defaultTrustPath = (): string => `${process.env.HOME}/.ax/team-trust.json`;

export async function loadTrust(path: string): Promise<TrustState> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return {};
    const parsed = decodeJsonOrNull(await f.text());
    return parsed && typeof parsed === "object" ? (parsed as TrustState) : {};
  } catch { return {}; }
}

export async function saveTrust(path: string, state: TrustState): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
  const r = Bun.spawnSync(["mv", tmp, path]);
  if (r.exitCode !== 0) { Bun.spawnSync(["rm", "-f", tmp]); throw new Error(`saveTrust: mv failed (${r.exitCode})`); }
}

/** Pure: bucket artifacts vs trusted hashes. `hashOf` gives each artifact's current hash. */
export const classify = (
  artifacts: ReadonlyArray<TeamArtifact>,
  hashOf: (a: TeamArtifact) => string,
  trust: TrustState,
): SyncClassification => {
  const added: TeamArtifact[] = [], changed: TeamArtifact[] = [], unchanged: TeamArtifact[] = [];
  for (const a of artifacts) {
    const rec = trust[artifactKey(a)];
    if (!rec) added.push(a);
    else if (rec.hash !== hashOf(a)) changed.push(a);
    else unchanged.push(a);
  }
  return { added, changed, unchanged };
};
