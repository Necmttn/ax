/** Paths named by an apply_patch envelope (`*** Update|Add|Delete File: p`). */
export const extractPatchPaths = (patch: string): string[] => {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    const p = m[1]?.trim();
    if (p) out.push(p);
  }
  return out;
};
