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

// Top-level commands that take a second positional word as part of their
// subcommand path (e.g. "sessions show", "skills weighted"). A stale or
// missing entry here only mislabels the command string - it never leaks data,
// because positionals beyond index 1 are always dropped regardless.
const KNOWN_SUBCOMMAND_FIRST = new Set([
  "sessions",   // sessions show / here / around / near / churn / compare / metrics
  "skills",     // skills classify / tag / weighted / by-role / roles / lint / …
  "cost",       // cost models / sessions / split
  "routing",    // routing tune / compile / show
  "profile",    // profile show / publish / unpublish
  "hooks",      // hooks log / summary / …
  "dojo",       // dojo agenda / report / draft / outbox / spar-plan / spar-score
  "agents",     // agents config / reconcile / scope / park / unpark / rm
  "classifiers", // classifiers subcommands
  "insights",   // insights subcommands
  "signals",    // signals list / …
  "evidence",   // evidence subcommands
  "project",    // project subcommands
  "costs",      // costs subcommands (legacy group)
  "wrapped",    // wrapped subcommands
  "daemon",     // daemon start / stop / restart / status
  "improve",    // improve recommend / lint / list / show / accept / …
  "retro",      // retro emit / list / pending / brief / reflect / meta / plan
  // Added: real group commands present in the CLI but missing from original set
  "dispatches", // dispatches compile-routing
  "ingest",     // ingest here
  "derive",     // derive signals / intents
  "serve",      // serve status / stop
]);

export const redactInvocation = (argv: ReadonlyArray<string>, inp: RecordInputs): UsageRecord => {
  const positionals = argv.filter((a) => !a.startsWith("-"));
  const head = positionals[0] ?? "(root)";
  const command = KNOWN_SUBCOMMAND_FIRST.has(head) && positionals[1]
    ? `${head} ${positionals[1]}`
    : head;
  const flags = [...new Set(
    argv.filter((a) => a.startsWith("-")).map((a) => a.split("=")[0]!),
  )].sort();
  const repo_key = inp.repoTopdir ? inp.repoTopdir.split("/").filter(Boolean).pop()!.toLowerCase() : null;
  return UsageRecord.make({
    ts: inp.now,
    command,
    flags,
    exit_code: inp.exitCode,
    duration_ms: inp.durationMs,
    origin: inp.isTty ? "tty" : "agent",
    repo_key,
    ax_version: inp.version,
  });
};

export async function appendUsageRecord(path: string, rec: UsageRecord): Promise<void> {
  try {
    const file = Bun.file(path);
    if (await file.exists() && file.size > MAX_LOG_BYTES) return;
    const prev = (await file.exists()) ? await file.text() : "";
    await Bun.write(path, `${prev}${encodeUsageLine(rec)}\n`, { createPath: true });
  } catch { /* never throw on the hot path */ }
}
