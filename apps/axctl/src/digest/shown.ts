import { decodeJsonOrNull } from "@ax/lib/decode";

export interface ShownRecord {
  readonly last_shown_at: string; // ISO
  readonly shown_count: number;
}
export type ShownState = Record<string, ShownRecord>;

export const defaultShownPath = (): string => `${process.env.HOME}/.ax/digest-shown.json`;

/** Read shown-state; never throws - corruption degrades to empty state. */
export async function loadShown(path: string): Promise<ShownState> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return {};
    const parsed = decodeJsonOrNull(await file.text());
    return parsed && typeof parsed === "object" ? (parsed as ShownState) : {};
  } catch {
    return {};
  }
}

/** Atomic write (tmp + mv), mirrors quota/cache.ts. node:fs is CI-banned. */
export async function saveShown(path: string, state: ShownState): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
  const result = Bun.spawnSync(["mv", tmp, path]);
  if (result.exitCode !== 0) {
    Bun.spawnSync(["rm", "-f", tmp]);
    throw new Error(`saveShown: mv failed (exit ${result.exitCode})`);
  }
}

export const recordShown = (prev: ShownState, ids: ReadonlyArray<string>, now: Date): ShownState => {
  const next: ShownState = { ...prev };
  for (const id of ids) {
    const existing = next[id];
    next[id] = {
      last_shown_at: now.toISOString(),
      shown_count: (existing?.shown_count ?? 0) + 1,
    };
  }
  return next;
};

/** Drop shown-state for ids no longer in the snapshot (resolved signals). */
export const pruneResolved = (prev: ShownState, liveIds: ReadonlySet<string>): ShownState => {
  const next: ShownState = {};
  for (const [id, rec] of Object.entries(prev)) if (liveIds.has(id)) next[id] = rec;
  return next;
};
