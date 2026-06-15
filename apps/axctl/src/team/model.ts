export type ArtifactKind = "skill" | "agent";

/** A non-executable team-rig artifact discovered in `.ax/`. `path` is the source
 *  (dir for a skill, file for an agent); `files` are the relative file paths to hash/copy. */
export interface TeamArtifact {
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly path: string;
  readonly files: ReadonlyArray<string>;
}

/** An executable artifact (`.ax/hooks/*`) - listed, never activated in Slice 0. */
export interface GatedArtifact {
  readonly kind: "hook";
  readonly name: string;
  readonly path: string;
}

export interface TrustRecord {
  readonly hash: string;
  readonly activated_at: string;
}
export type TrustState = Record<string, TrustRecord>;

export interface SyncClassification {
  readonly added: ReadonlyArray<TeamArtifact>;
  readonly changed: ReadonlyArray<TeamArtifact>;
  readonly unchanged: ReadonlyArray<TeamArtifact>;
}

export const artifactKey = (a: TeamArtifact): string => `${a.kind}:${a.name}`;
