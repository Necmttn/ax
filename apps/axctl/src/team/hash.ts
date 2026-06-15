import type { TeamArtifact } from "./model.ts";

/** Stable content hash over the artifact's files (sorted path + content), so
 *  reorderings don't change it but any content change does. `readFile(abs)`
 *  returns the file text. Pure given the reader. For a skill, abs = `${path}/${rel}`;
 *  for an agent (single file), abs = `path` itself. */
export const hashArtifact = (a: TeamArtifact, readFile: (abs: string) => string): string => {
  const parts = [...a.files].sort().map((rel) => {
    const abs = a.kind === "agent" ? a.path : `${a.path}/${rel}`;
    return `${rel}\0${readFile(abs)}`;
  });
  return Bun.hash(parts.join("\0\0")).toString(16);
};
