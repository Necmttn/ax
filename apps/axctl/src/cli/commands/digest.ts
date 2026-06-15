/**
 * `ax digest` - render the local digest board (your own ax signal).
 *   ax digest            render the stored snapshot (~/.ax/digest.json)
 *   ax digest --json     print the raw snapshot JSON
 *   ax digest --refresh  recompute the snapshot now, then render
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { DigestSnapshot, decodeSnapshotOrNull } from "../../digest/model.ts";
import { buildAndWrite, defaultDigestPath } from "../../digest/snapshot.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { jsonFlag } from "./shared.ts";

/** Full-board CLI render (ALL stored items, not the hook's top-3). Pure. */
export const renderDigestCli = (snap: DigestSnapshot): string => {
    if (snap.items.length === 0) return "[ax] nothing to surface right now.";
    const lines = snap.items.map((it) => `  • ${it.text}\n      → ${it.action}`);
    return [`[ax] your board (${snap.window_days}d window):`, ...lines].join("\n");
};

const cmdDigest = (input: { readonly json: boolean; readonly refresh: boolean }) =>
    Effect.gen(function* () {
        let snap: DigestSnapshot | null;
        if (input.refresh) {
            snap = yield* buildAndWrite(new Date(), 14);
        } else {
            const text = yield* Effect.promise(async () => {
                const f = Bun.file(defaultDigestPath());
                return (await f.exists()) ? await f.text() : null;
            });
            snap = text ? decodeSnapshotOrNull(text) : null;
        }
        if (!snap) {
            console.log(
                input.json
                    ? "null"
                    : "[ax] no snapshot yet - run `ax digest --refresh` or ingest first.",
            );
            return;
        }
        console.log(input.json ? prettyPrint(snap) : renderDigestCli(snap));
    });

export const digestCommand = Command.make(
    "digest",
    {
        json: jsonFlag,
        refresh: Flag.boolean("refresh").pipe(Flag.withDefault(false)),
    },
    ({ json, refresh }) => cmdDigest({ json, refresh }),
).pipe(
    Command.withDescription(
        "Your local digest board: ranked ax signal (improve/cost/churn/quota). --json (raw snapshot)  --refresh (recompute now)",
    ),
);

export const digestRuntime: RuntimeManifest = {
    digest: {
        runtime: "db",
        hidden: false,
    },
};
