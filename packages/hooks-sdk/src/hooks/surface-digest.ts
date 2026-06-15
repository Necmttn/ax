import { Effect } from "effect";
import {
  type DigestSnapshotJson,
  type ShownState,
  isSnapshotFresh,
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

const recordShownIds = async (path: string, ids: string[], now: Date): Promise<void> => {
  if (ids.length === 0) return;
  const prev = (await readJson<ShownState>(path)) ?? {};
  const next: ShownState = { ...prev };
  for (const id of ids) {
    next[id] = {
      last_shown_at: now.toISOString(),
      shown_count: (prev[id]?.shown_count ?? 0) + 1,
    };
  }
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
      yield* Effect.promise(() => recordShownIds(SHOWN_PATH(), shownIds, now));
      return verdict;
    }),
});

export default hook;
if (import.meta.main) void runMain(hook);
