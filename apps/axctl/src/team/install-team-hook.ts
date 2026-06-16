import { Effect } from "effect";
import { installHookFile } from "../hooks/sdk-install.ts";
import type { HookScope } from "../hooks/providers/types.ts";

/**
 * Returns true only when the hook name is safe to use as a filename segment
 * under ~/.ax/hooks/<name>.ts (no path-traversal characters).
 */
export const isSafeHookName = (n: string): boolean =>
    /^[a-zA-Z0-9._-]+$/.test(n) && n !== "." && n !== "..";

/**
 * Compute the stable snapshot path for a team hook.
 * The file lives in ~/.ax/hooks/<name>.ts - a user-owned copy, NOT a symlink
 * to the repo, so a later repo change cannot silently mutate an installed hook.
 */
export const hookSnapshotPath = (name: string, home: string): string =>
    `${home}/.ax/hooks/${name}.ts`;

/**
 * Write the trusted hook content to its snapshot path.
 * Throws when `name` fails the safety check so nothing ever writes outside
 * the ~/.ax/hooks/ directory.
 */
export async function snapshotHook(
    name: string,
    content: string,
    home: string,
): Promise<string> {
    if (!isSafeHookName(name)) throw new Error(`unsafe hook name: ${name}`);
    const path = hookSnapshotPath(name, home);
    await Bun.write(path, content, { createPath: true });
    return path;
}

/**
 * Snapshot a trusted team hook and install it into the given providers.
 *
 * - `name`      – hook name (must pass isSafeHookName)
 * - `content`   – the trusted hook source (the snapshot is a stable COPY)
 * - `home`      – user home dir (defaults to process.env.HOME)
 * - `providers` – provider list forwarded to installHookFile (e.g. ["claude"])
 *
 * Uses "global" scope so the hook fires in every project for the user.
 */
export const installTeamHook = (
    name: string,
    content: string,
    home: string,
    providers: ReadonlyArray<string>,
) =>
    Effect.gen(function* () {
        const path = yield* Effect.promise(() => snapshotHook(name, content, home));
        const scope: HookScope = "global";
        return yield* installHookFile(path, providers, scope);
    });
