/**
 * `ax quota` - live Claude plan usage (5h / 7d windows) from the Anthropic
 * OAuth usage endpoint, claude-meter style. Reads the Claude Code OAuth
 * token (Keychain / ~/.claude/.credentials.json), caches the response at
 * ~/.ax/quota-cache.json (default TTL 60s) so statusline/menubar callers can
 * poll freely without hammering the endpoint.
 *
 *   ax quota                 human table
 *   ax quota --json          QuotaSnapshot JSON
 *   ax quota --statusline    one line, e.g. for Claude Code statusLine:
 *                            { "statusLine": { "type": "command",
 *                              "command": "axctl quota --statusline" } }
 *   ax quota --swiftbar      SwiftBar/xbar plugin body (menubar)
 *
 * Render-only modes (--statusline/--swiftbar) never fail loud: on any error
 * they print a quiet "quota n/a" and exit 0, because their output lands in
 * UI chrome.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { defaultQuotaCachePath } from "../../quota/cache.ts";
import { renderQuotaTable, renderStatusline, renderSwiftBar } from "../../quota/format.ts";
import { QuotaEnvLive } from "../../quota/quota-env.ts";
import { getQuota, type QuotaResult } from "../../quota/quota.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag } from "./shared.ts";

const TOKEN_HELP =
    "ax quota: no Claude Code OAuth token found.\n" +
    "Looked in the macOS Keychain (service \"Claude Code-credentials\") and\n" +
    "~/.claude/.credentials.json - is Claude Code installed and logged in?";

const sourceNote = (result: QuotaResult): string =>
    result.source === "live"
        ? "live"
        : result.source === "cache"
            ? "cached"
            : "stale cache - usage endpoint unreachable";

const cmdQuota = (input: {
    readonly json: boolean;
    readonly statusline: boolean;
    readonly swiftbar: boolean;
    readonly maxAgeSeconds: number;
}) => {
    const nowMs = Date.now();
    const quiet = input.statusline || input.swiftbar;
    const render = (result: QuotaResult): string => {
        if (input.json) return prettyPrint({ ...result.snapshot, source: result.source });
        if (input.statusline) return renderStatusline(result.snapshot, { nowMs });
        if (input.swiftbar) return renderSwiftBar(result.snapshot, { nowMs });
        return renderQuotaTable(result.snapshot, { nowMs, sourceNote: sourceNote(result) });
    };
    return getQuota({
        cachePath: defaultQuotaCachePath(),
        maxAgeSeconds: input.maxAgeSeconds,
        nowMs,
    }).pipe(
        Effect.map((result) => {
            console.log(render(result));
        }),
        Effect.catch((error) =>
            Effect.sync(() => {
                if (quiet) {
                    // UI chrome: degrade silently, never an error dump.
                    console.log(input.swiftbar ? "◌ quota n/a" : "quota n/a");
                    return;
                }
                console.error(
                    error._tag === "QuotaTokenMissing"
                        ? TOKEN_HELP
                        : `ax quota: usage endpoint failed (${error.message})`,
                );
                process.exit(1);
            }),
        ),
        Effect.provide(QuotaEnvLive),
    );
};

export const quotaCommand = Command.make(
    "quota",
    {
        json: jsonFlag,
        statusline: Flag.boolean("statusline").pipe(Flag.withDefault(false)),
        swiftbar: Flag.boolean("swiftbar").pipe(Flag.withDefault(false)),
        maxAge: Flag.integer("max-age").pipe(Flag.withDefault(60)),
        fresh: Flag.boolean("fresh").pipe(Flag.withDefault(false)),
    },
    ({ json, statusline, swiftbar, maxAge, fresh }) => {
        if (!Number.isInteger(maxAge) || maxAge < 0) {
            fail(`ax quota: --max-age must be a non-negative integer of seconds (got "${maxAge}")`);
        }
        if ([json, statusline, swiftbar].filter(Boolean).length > 1) {
            fail("ax quota: --json, --statusline, and --swiftbar are mutually exclusive");
        }
        return cmdQuota({
            json,
            statusline,
            swiftbar,
            maxAgeSeconds: fresh ? 0 : maxAge,
        });
    },
).pipe(
    Command.withDescription(
        "Claude plan quota: 5h/7d window utilization from the Anthropic usage endpoint. " +
        "--json  --statusline (one line)  --swiftbar (menubar plugin)  --max-age=N seconds (default 60)  --fresh",
    ),
);

export const quotaRuntime: RuntimeManifest = {
    quota: "none",
};
