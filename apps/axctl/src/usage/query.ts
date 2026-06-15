import { Effect } from "effect";
import type { DbError } from "@ax/lib/errors";
import { SurrealClient } from "@ax/lib/db";

export interface InvocationRow {
  readonly ts: string;
  readonly command: string;
  readonly origin: "tty" | "agent";
  readonly exit_code: number;
}

export interface UsageRollup {
  readonly windowDays: number;
  readonly total: number;
  readonly activeDays: number;
  readonly topCommands: ReadonlyArray<{ command: string; count: number; last_used: string }>;
  readonly unusedSurface: string[];
  readonly originSplit: { agent: number; tty: number };
  readonly reliability: ReadonlyArray<{ command: string; runs: number; failures: number; failureRate: number }>;
}

const utcDay = (iso: string): string => iso.slice(0, 10);

export const rollup = (rows: ReadonlyArray<InvocationRow>, visibleCommands: ReadonlyArray<string>, windowDays = 30): UsageRollup => {
  const byCommand = new Map<string, { count: number; last: string; failures: number }>();
  const days = new Set<string>();
  let agent = 0, tty = 0;
  for (const r of rows) {
    days.add(utcDay(r.ts));
    if (r.origin === "tty") tty++; else agent++;
    const e = byCommand.get(r.command) ?? { count: 0, last: r.ts, failures: 0 };
    e.count++;
    if (r.ts > e.last) e.last = r.ts;
    if (r.exit_code !== 0) e.failures++;
    byCommand.set(r.command, e);
  }
  const topCommands = [...byCommand.entries()]
    .map(([command, e]) => ({ command, count: e.count, last_used: e.last }))
    .sort((a, b) => b.count - a.count || (a.command < b.command ? -1 : 1));
  // unusedSurface compares against top-level command tokens (VISIBLE_COMMANDS is
  // top-level), so normalize invoked commands to their first token.
  const invokedTop = new Set([...byCommand.keys()].map((c) => c.split(" ")[0]));
  const unusedSurface = visibleCommands.filter((c) => !invokedTop.has(c));
  const reliability = [...byCommand.entries()]
    .map(([command, e]) => ({ command, runs: e.count, failures: e.failures, failureRate: e.failures / e.count }))
    .filter((x) => x.failures > 0)
    .sort((a, b) => b.failureRate - a.failureRate);
  return { windowDays, total: rows.length, activeDays: days.size, topCommands, unusedSurface, originSplit: { agent, tty }, reliability };
};

export const fetchInvocations = (windowDays: number): Effect.Effect<InvocationRow[], DbError, SurrealClient> =>
  Effect.gen(function* () {
    const db = yield* SurrealClient;
    const result = yield* db.query<[InvocationRow[]]>(
      `SELECT type::string(ts) AS ts, command, origin, exit_code FROM ax_invocation WHERE ts > time::now() - ${Math.max(1, Math.trunc(windowDays))}d;`,
    );
    return result?.[0] ?? [];
  });
