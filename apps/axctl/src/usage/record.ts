import { UsageRecord, encodeUsageLine } from "./model.ts";

export const defaultUsageLogPath = (): string => `${process.env.HOME}/.ax/usage-log.jsonl`;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface RecordInputs {
  readonly now: Date;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly isTty: boolean;
  readonly repoTopdir: string | null;
  readonly version: string;
}

// Verbs/command names are short lowercase kebab tokens. Anything else
// (a path, an id, a query, a --escaped value) is user data → never persisted.
const VERB = /^[a-z][a-z-]{0,30}$/;

export const redactInvocation = (argv: ReadonlyArray<string>, inp: RecordInputs): UsageRecord => {
  // Everything after a bare "--" is end-of-options USER DATA, never a subcommand.
  const sep = argv.indexOf("--");
  const scan = sep === -1 ? argv : argv.slice(0, sep);

  const positionals = scan.filter((a) => !a.startsWith("-"));
  // Record ONLY the top-level subcommand (validated). The second positional is
  // user-controllable (branch/skill/slug names) for some groups, so it is never
  // captured - top-level granularity is the safe surface (this data is the basis
  // for the future external team-publish). A non-command head -> "(unknown)".
  const command = positionals[0] && VERB.test(positionals[0]) ? positionals[0] : "(unknown)";

  const flags = [...new Set(
    scan.filter((a) => a.startsWith("-") && a !== "--").map((a) => a.split("=")[0]!),
  )].sort();

  const repo_key = inp.repoTopdir ? inp.repoTopdir.split("/").filter(Boolean).pop()!.toLowerCase() : null;
  return UsageRecord.make({
    ts: inp.now, command, flags,
    exit_code: inp.exitCode, duration_ms: inp.durationMs,
    origin: inp.isTty ? "tty" : "agent", repo_key, ax_version: inp.version,
  });
};

// v0 tradeoff: read-modify-write; a line may be lost under concurrent
// invocations (acceptable for telemetry), bounded by the 5MB cap +
// per-ingest truncation. node:fs appendFile is banned by check:no-node-fs.
export async function appendUsageRecord(path: string, rec: UsageRecord): Promise<void> {
  try {
    const file = Bun.file(path);
    if (await file.exists() && file.size > MAX_LOG_BYTES) return;
    const prev = (await file.exists()) ? await file.text() : "";
    await Bun.write(path, `${prev}${encodeUsageLine(rec)}\n`, { createPath: true });
  } catch { /* never throw on the hot path */ }
}
