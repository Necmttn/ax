/**
 * verify-helper-bundle.ts - parse the LaunchAgent plist for the ax studio helper
 * and return it as a plain JSON object for assertion.
 *
 * Uses `plutil -convert json` (macOS built-in) so no extra deps are needed.
 * This lives in scripts/ (not apps/ runtime), so node:* imports are allowed.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = dirname(HERE); // apps/studio-desktop

/**
 * Canonical path to the helper plist source file (committed, not staged).
 * electron-builder copies it to Contents/Library/LaunchAgents/ at package time.
 */
export const PLIST_PATH = join(
    APP_ROOT,
    "build",
    "LaunchAgents",
    "com.necmttn.ax-studio.helper.plist",
);

export type PlistJson = Record<string, unknown>;

/**
 * Parse a plist file into a JSON object using `plutil -convert json`.
 * Throws if plutil fails (file missing, malformed XML, etc.).
 */
export function parseHelperPlist(plistPath: string = PLIST_PATH): PlistJson {
    const r = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
        encoding: "utf8",
    });
    if (r.status !== 0 || r.error) {
        throw new Error(
            `plutil failed (exit ${r.status ?? "error"}) for ${plistPath}: ${r.stderr || r.stdout || String(r.error)}`,
        );
    }
    return JSON.parse(r.stdout) as PlistJson;
}
