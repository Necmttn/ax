import { Effect } from "effect";
import {
  type DigestSnapshotJson,
  type ShownState,
  isSnapshotFresh,
  mergeShownState,
  pickUnshownJson,
  renderDigestJson,
} from "@ax/lib/digest-shared";
import { defineHook, runMain } from "../define.ts";
import { Verdict } from "../verdict.ts";

const DIGEST_PATH = () => `${process.env.HOME}/.ax/digest.json`;
const SHOWN_PATH = () => `${process.env.HOME}/.ax/digest-shown.json`;
const MAX_AGE_HOURS = 24;

/** Pure decision: returns the verdict + which ids were shown (for recording).
 *  Stale/empty/suppressed → Allow (silent). Unit-tested. */
export const decideDigestVerdict = (
  snap: DigestSnapshotJson | null,
  shown: ShownState,
  now: Date,
  maxAgeHours: number,
): { verdict: Verdict; shownIds: string[] } => {
  if (!snap || !isSnapshotFresh(snap, now, maxAgeHours)) return { verdict: Verdict.allow, shownIds: [] };
  const picked = pickUnshownJson(snap.items, shown, now, 3);
  const text = renderDigestJson(picked);
  if (!text) return { verdict: Verdict.allow, shownIds: [] };
  return { verdict: Verdict.inject(text), shownIds: picked.map((p) => p.id) };
};

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return JSON.parse(await f.text()) as T;
  } catch {
    return null;
  }
};

const writeShownState = async (path: string, next: ShownState): Promise<void> => {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, `${JSON.stringify(next, null, 2)}\n`, { createPath: true });
    Bun.spawnSync(["mv", tmp, path]);
  } catch {
    /* degrade to no-dedup; never crash the hook */
  }
};

const hook = defineHook({
  name: "surface-digest",
  events: ["SessionStart"],
  run: (_event) =>
    Effect.gen(function* () {
      const now = new Date();
      const snap = yield* Effect.promise(() => readJson<DigestSnapshotJson>(DIGEST_PATH()));
      const shown = (yield* Effect.promise(() => readJson<ShownState>(SHOWN_PATH()))) ?? {};
      const { verdict, shownIds } = decideDigestVerdict(snap, shown, now, MAX_AGE_HOURS);
      // Prune resolved entries when we have a fresh snapshot, even if nothing was shown.
      const fresh = snap !== null && isSnapshotFresh(snap, now, MAX_AGE_HOURS);
      const liveIds = fresh ? new Set(snap.items.map((i) => i.id)) : null;
      if (liveIds !== null) {
        const next = mergeShownState(shown, shownIds, liveIds, now);
        yield* Effect.promise(() => writeShownState(SHOWN_PATH(), next));
      }
      return verdict;
    }),
});

export default hook;
if (import.meta.main) void runMain(hook);
