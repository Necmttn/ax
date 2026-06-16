import { scanAxFolder } from "./scan.ts";
import type { GatedArtifact, TeamArtifact } from "./model.ts";

export const AX_LOCAL_DIR = ".ax.local";

export type OverlayArtifact = TeamArtifact & { readonly overlay: boolean };
export type OverlayGated = GatedArtifact & { readonly overlay: boolean };
export interface OverlayScan {
  readonly artifacts: ReadonlyArray<OverlayArtifact>;
  readonly gated: ReadonlyArray<OverlayGated>;
}

/** Merge committed `.ax/` + `.ax.local/`, overlay winning on (kind,name). */
export const scanWithOverlay = async (root: string): Promise<OverlayScan> => {
  const base = await scanAxFolder(root, ".ax");
  const over = await scanAxFolder(root, AX_LOCAL_DIR);
  const merge = <T extends { kind: string; name: string }>(
    b: ReadonlyArray<T>,
    o: ReadonlyArray<T>,
  ): Array<T & { overlay: boolean }> => {
    const byKey = new Map<string, T & { overlay: boolean }>();
    for (const x of b) byKey.set(`${x.kind}:${x.name}`, { ...x, overlay: false });
    for (const x of o) byKey.set(`${x.kind}:${x.name}`, { ...x, overlay: true });
    return [...byKey.values()].sort((a, b2) => a.name.localeCompare(b2.name));
  };
  return {
    artifacts: merge(base.artifacts, over.artifacts) as OverlayArtifact[],
    gated: merge(base.gated, over.gated) as OverlayGated[],
  };
};
