import { Effect } from "effect";
import type { DbError } from "@ax/lib/errors";
import { SurrealClient } from "@ax/lib/db";

export interface InvocationRow {
  readonly ts: string;
  readonly command: string;
  readonly origin: "tty" | "agent";
  readonly exit_code: number;
}

export interface TopCommand {
  readonly command: string;
  readonly count: number;
  readonly last_used: string;
}

export interface UsageRollup {
  readonly windowDays: number;
  readonly total: number;
  readonly activeDays: number;
  readonly topCommands: ReadonlyArray<TopCommand>;
  readonly topCommandsByOrigin: {
    readonly agent: ReadonlyArray<TopCommand>;
    readonly tty: ReadonlyArray<TopCommand>;
  };
  readonly unusedSurface: string[];
  readonly originSplit: { agent: number; tty: number };
  readonly reliability: ReadonlyArray<{ command: string; runs: number; failures: number; failureRate: number }>;
}

const utcDay = (iso: string): string => iso.slice(0, 10);

type CommandStats = { count: number; last: string; failures: number };

const bumpCommand = (map: Map<string, CommandStats>, row: InvocationRow): void => {
  const e = map.get(row.command) ?? { count: 0, last: row.ts, failures: 0 };
  e.count++;
  if (row.ts > e.last) e.last = row.ts;
  if (row.exit_code !== 0) e.failures++;
  map.set(row.command, e);
};

const rankCommands = (map: Map<string, CommandStats>): TopCommand[] =>
  [...map.entries()]
    .map(([command, e]) => ({ command, count: e.count, last_used: e.last }))
    .sort((a, b) => b.count - a.count || (a.command < b.command ? -1 : 1));

export const rollup = (rows: ReadonlyArray<InvocationRow>, visibleCommands: ReadonlyArray<string>, windowDays = 30): UsageRollup => {
  const byCommand = new Map<string, { count: number; last: string; failures: number }>();
  const byAgentCommand = new Map<string, CommandStats>();
  const byTtyCommand = new Map<string, CommandStats>();
  const days = new Set<string>();
  let agent = 0, tty = 0;
  for (const r of rows) {
    days.add(utcDay(r.ts));
    if (r.origin === "tty") {
      tty++;
      bumpCommand(byTtyCommand, r);
    } else {
      agent++;
      bumpCommand(byAgentCommand, r);
    }
    bumpCommand(byCommand, r);
  }
  const topCommands = rankCommands(byCommand);
  // unusedSurface compares against top-level command tokens (VISIBLE_COMMANDS is
  // top-level), so normalize invoked commands to their first token.
  const invokedTop = new Set([...byCommand.keys()].map((c) => c.split(" ")[0]));
  const unusedSurface = visibleCommands.filter((c) => !invokedTop.has(c));
  const reliability = [...byCommand.entries()]
    .map(([command, e]) => ({ command, runs: e.count, failures: e.failures, failureRate: e.failures / e.count }))
    .filter((x) => x.failures > 0)
    .sort((a, b) => b.failureRate - a.failureRate);
  return {
    windowDays,
    total: rows.length,
    activeDays: days.size,
    topCommands,
    topCommandsByOrigin: {
      agent: rankCommands(byAgentCommand),
      tty: rankCommands(byTtyCommand),
    },
    unusedSurface,
    originSplit: { agent, tty },
    reliability,
  };
};

export const fetchInvocations = (windowDays: number): Effect.Effect<InvocationRow[], DbError, SurrealClient> =>
  Effect.gen(function* () {
    const db = yield* SurrealClient;
    const result = yield* db.query<[InvocationRow[]]>(
      `SELECT type::string(ts) AS ts, command, origin, exit_code FROM ax_invocation WHERE ts > time::now() - ${Math.max(1, Math.trunc(windowDays))}d;`,
    );
    return result?.[0] ?? [];
  });
