import { decodeJsonOrNull } from "@ax/lib/decode";
import type { GatedArtifact } from "./model.ts";

export interface ExecTrustRecord {
  readonly sha256: string;
  readonly content: string;
  readonly trusted_at: string;
}
export type ExecTrustState = Record<string, ExecTrustRecord>; // key: "hook:<name>"

export const execKey = (h: GatedArtifact): string => `${h.kind}:${h.name}`;
export const defaultExecTrustPath = (): string => `${process.env.HOME}/.ax/team-trust-exec.json`;

export async function loadExecTrust(path: string): Promise<ExecTrustState> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return {};
    const p = decodeJsonOrNull(await f.text());
    return p && typeof p === "object" ? (p as ExecTrustState) : {};
  } catch { return {}; }
}

export async function saveExecTrust(path: string, state: ExecTrustState): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
  const r = Bun.spawnSync(["mv", tmp, path]);
  if (r.exitCode !== 0) { Bun.spawnSync(["rm", "-f", tmp]); throw new Error(`saveExecTrust: mv failed (${r.exitCode})`); }
}

export interface ExecClassification {
  readonly added: ReadonlyArray<GatedArtifact>;
  readonly changed: ReadonlyArray<GatedArtifact>;
  readonly trusted: ReadonlyArray<GatedArtifact>;
}

export const classifyExec = (
  hooks: ReadonlyArray<GatedArtifact>,
  shaOf: (h: GatedArtifact) => string,
  trust: ExecTrustState,
): ExecClassification => {
  const added: GatedArtifact[] = [], changed: GatedArtifact[] = [], trusted: GatedArtifact[] = [];
  for (const h of hooks) {
    const rec = trust[execKey(h)];
    if (!rec) added.push(h);
    else if (rec.sha256 !== shaOf(h)) changed.push(h);
    else trusted.push(h);
  }
  return { added, changed, trusted };
};
