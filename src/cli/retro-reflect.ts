/**
 * `axctl retro reflect` - walk the user through clustered retro-derived
 * proposals interactively. Sibling of `retro emit` + `retro list`.
 *
 * Wedge scope: read `proposal` + `skill_proposal` for rows whose id
 * contains the retro marker (`skill__retro__`, the prefix used by
 * derive-retro-proposals.ts via `proposalKeyFor`). Render a one-line
 * ranked table, then loop through each pattern and prompt accept /
 * reject / skip. accept and reject shell out to `axctl improve` so the
 * subagent flag (`AX_RETRO_REFLECT_AGENT=1` -> --with-agent) and `--reason`
 * paths reuse the existing handlers.
 *
 * `--yes` short-circuits the prompt loop into auto-accept-everything for
 * non-interactive scripts (cron, CI). `--json` prints the patterns array
 * and exits.
 *
 * Provenance: `retroKeys` + `sessionKeys` are pulled back out of
 * `proposal.baseline` (where derive-retro-proposals stuffs them as JSON,
 * because `cites_evidence` doesn't yet include `retro` in its TO union).
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { prettyPrint } from "../lib/json.ts";

export interface RetroReflectRow {
    readonly proposalKey: string;
    readonly dedupeSig: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly frequency: number;
    readonly confidence: string;
    readonly triggerPattern: string;
    readonly suspectedGap: string;
    readonly proposedBehavior: string;
    readonly retroKeys: readonly string[];
    readonly sessionKeys: readonly string[];
}

export interface RetroReflectSummary {
    readonly patterns: readonly RetroReflectRow[];
    readonly totalRetros: number;
    readonly totalSessions: number;
}

/**
 * Build the SurrealQL that selects retro-derived proposals joined with
 * their skill_proposal payload. We filter on `string::contains(id, '...')`
 * so the marker prefix from derive-retro-proposals.ts is the only thing
 * that has to stay in sync. Status filter: 'open' by default, 'all'
 * means no filter.
 */
export const buildRetroReflectQuery = (opts: {
    readonly sinceDays: number;
    readonly status: string;
}): string => {
    const sinceDays = Math.max(1, Math.floor(opts.sinceDays));
    const statusClause = opts.status === "all"
        ? ""
        : ` AND status = '${opts.status.replace(/'/g, "")}'`;
    return `SELECT
        id,
        dedupe_sig,
        title,
        hypothesis,
        frequency,
        confidence,
        status,
        baseline,
        (SELECT trigger_pattern, suspected_gap, proposed_behavior
         FROM skill_proposal
         WHERE proposal = $parent.id LIMIT 1)[0] AS payload
    FROM proposal
    WHERE string::contains(<string>id, 'skill__retro__')
      AND updated_at > time::now() - ${sinceDays}d${statusClause}
    ORDER BY frequency DESC LIMIT 50;`;
};

/**
 * Render the 5-column ranked table. Columns: rank, freq, conf, sessions,
 * title. 80-col friendly; long titles are truncated with an ellipsis.
 */
export const renderReflectTable = (rows: readonly RetroReflectRow[]): string => {
    const header = `  #  FREQ  CONF    SESSIONS  TITLE`;
    if (rows.length === 0) {
        return `${header}\n  (none)`;
    }
    const lines: string[] = [header];
    rows.forEach((row, idx) => {
        const rank = String(idx + 1).padStart(2);
        const freq = String(row.frequency).padStart(4);
        const conf = row.confidence.padEnd(6);
        const sess = String(row.sessionKeys.length).padStart(8);
        const title = row.title.length > 50 ? `${row.title.slice(0, 49)}…` : row.title;
        lines.push(`  ${rank} ${freq}  ${conf}  ${sess}  ${title}`);
    });
    return lines.join("\n");
};

export const renderReflectDetail = (row: RetroReflectRow): string => {
    return [
        `Title:    ${row.title}`,
        `DedupeSig: ${row.dedupeSig}`,
        `Hypothesis: ${row.hypothesis}`,
        `Trigger:  ${row.triggerPattern}`,
        `Behavior: ${row.proposedBehavior}`,
        `Evidence: ${row.retroKeys.length} retro(s) across ${row.sessionKeys.length} session(s) · freq=${row.frequency} · conf=${row.confidence}`,
    ].join("\n");
};

interface ProposalIdLike { readonly tb?: string; readonly id?: string }

const idToKey = (raw: unknown): string => {
    if (raw === null || raw === undefined) return "";
    if (typeof raw === "string") {
        const idx = raw.indexOf(":");
        return idx >= 0 ? raw.slice(idx + 1) : raw;
    }
    const obj = raw as ProposalIdLike;
    return obj.id ?? "";
};

const parseBaselineArrays = (
    baseline: unknown,
): { readonly retroKeys: readonly string[]; readonly sessionKeys: readonly string[] } => {
    if (typeof baseline !== "string" || baseline.length === 0) {
        return { retroKeys: [], sessionKeys: [] };
    }
    try {
        const parsed = JSON.parse(baseline) as {
            retroKeys?: unknown;
            sessionKeys?: unknown;
        };
        const toStrings = (v: unknown): string[] =>
            Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        return {
            retroKeys: toStrings(parsed.retroKeys),
            sessionKeys: toStrings(parsed.sessionKeys),
        };
    } catch {
        return { retroKeys: [], sessionKeys: [] };
    }
};

const summariseRows = (rawRows: readonly Record<string, unknown>[]): RetroReflectSummary => {
    const patterns: RetroReflectRow[] = [];
    const retroSet = new Set<string>();
    const sessionSet = new Set<string>();
    for (const r of rawRows) {
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        const { retroKeys, sessionKeys } = parseBaselineArrays(r.baseline);
        for (const k of retroKeys) retroSet.add(k);
        for (const k of sessionKeys) sessionSet.add(k);
        patterns.push({
            proposalKey: idToKey(r.id),
            dedupeSig: String(r.dedupe_sig ?? ""),
            title: String(r.title ?? ""),
            hypothesis: String(r.hypothesis ?? ""),
            frequency: Number(r.frequency ?? 0),
            confidence: String(r.confidence ?? "low"),
            triggerPattern: String(payload.trigger_pattern ?? ""),
            suspectedGap: String(payload.suspected_gap ?? ""),
            proposedBehavior: String(payload.proposed_behavior ?? ""),
            retroKeys,
            sessionKeys,
        });
    }
    return { patterns, totalRetros: retroSet.size, totalSessions: sessionSet.size };
};

const promptChoice = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    const chunks: Uint8Array[] = [];
    for await (const chunk of Bun.stdin.stream()) {
        chunks.push(chunk as Uint8Array);
        const combined = Buffer.concat(chunks).toString("utf-8");
        if (combined.includes("\n")) {
            return combined.split("\n")[0].trim().toLowerCase();
        }
    }
    return Buffer.concat(chunks).toString("utf-8").trim().toLowerCase();
};

const promptLine = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    const chunks: Uint8Array[] = [];
    for await (const chunk of Bun.stdin.stream()) {
        chunks.push(chunk as Uint8Array);
        const combined = Buffer.concat(chunks).toString("utf-8");
        if (combined.includes("\n")) {
            return combined.split("\n")[0].trim();
        }
    }
    return Buffer.concat(chunks).toString("utf-8").trim();
};

const runImproveSubcmd = async (args: readonly string[]): Promise<number> => {
    // Shell out to the same axctl binary. For a Bun-compiled SEA binary,
    // argv[0] is the internal `/$bunfs/...` VFS path which cannot be spawned
    // directly; use `process.execPath` (the real on-disk binary). For dev
    // (`bun run src/cli/index.ts`), execPath ends with `/bun` and we need to
    // re-pass argv[1] (the script path).
    const exec = process.execPath;
    const cmd = exec.endsWith("/bun") || exec === "bun"
        ? [exec, process.argv[1], ...args]
        : [exec, ...args];
    const child = Bun.spawn(cmd, {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
    });
    return await child.exited;
};

const flagValue = (args: string[], name: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit?.split("=").slice(1).join("=");
};

export const cmdRetroReflect = (
    args: string[],
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const sinceRaw = flagValue(args, "since");
        const sinceDays = sinceRaw !== undefined && /^\d+$/.test(sinceRaw)
            ? Math.max(1, parseInt(sinceRaw, 10))
            : 30;
        const status = flagValue(args, "status") ?? "open";
        const json = args.includes("--json");
        const yes = args.includes("--yes");
        const withAgent = process.env.AX_RETRO_REFLECT_AGENT === "1";

        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            buildRetroReflectQuery({ sinceDays, status }),
        );
        const rawRows = result?.[0] ?? [];
        const summary = summariseRows(rawRows);

        if (json) {
            console.log(prettyPrint(summary.patterns));
            return;
        }

        if (summary.patterns.length === 0) {
            console.log(`(no retro-derived proposals in the last ${sinceDays}d with status=${status})`);
            console.log("  try `axctl ingest --stages=derive-retro-proposals` to seed some");
            return;
        }

        console.log(renderReflectTable(summary.patterns));
        console.log("");
        console.log(`${summary.patterns.length} pattern(s) · ${summary.totalRetros} retro(s) · ${summary.totalSessions} session(s)`);
        console.log("");

        let accepted = 0;
        let rejected = 0;
        let skipped = 0;

        for (let i = 0; i < summary.patterns.length; i++) {
            const row = summary.patterns[i];
            console.log(`--- [${i + 1}/${summary.patterns.length}] ---`);
            console.log(renderReflectDetail(row));
            console.log("");

            let choice: string;
            if (yes) {
                choice = "a";
                console.log("(auto-accept via --yes)");
            } else {
                choice = yield* Effect.promise(() => promptChoice("accept / reject / skip [a/r/s]? "));
            }

            if (choice === "a" || choice === "accept") {
                const acceptArgs = ["improve", "accept", row.dedupeSig];
                if (withAgent) acceptArgs.push("--with-agent");
                const code = yield* Effect.promise(() => runImproveSubcmd(acceptArgs));
                if (code === 0) accepted += 1;
                else skipped += 1;
            } else if (choice === "r" || choice === "reject") {
                const reason = yes
                    ? "not_worth_packaging"
                    : yield* Effect.promise(() => promptLine("reason: "));
                const rejectArgs = ["improve", "reject", row.dedupeSig, `--reason=${reason || "not_worth_packaging"}`];
                const code = yield* Effect.promise(() => runImproveSubcmd(rejectArgs));
                if (code === 0) rejected += 1;
                else skipped += 1;
            } else {
                skipped += 1;
            }
            console.log("");
        }

        console.log(
            `Accepted ${accepted}, rejected ${rejected}, skipped ${skipped} of ${summary.patterns.length} patterns.`,
        );
    });
