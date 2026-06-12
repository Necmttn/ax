import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { Effect, FileSystem, Path } from "effect";
import { jsonRecordField } from "@ax/lib/decode";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { posixPath } from "@ax/lib/shared/path";
import {
    recentFrictionSql,
    repositoryOverviewSql,
    schemaCoverageSql,
    sessionEvidenceSql,
    toolFailuresSql,
} from "../queries/insights.ts";
import { fetchWorktreesOverview } from "./worktrees-overview.ts";

type Row = Record<string, unknown>;

export interface DashboardCounts {
    readonly toolCalls: number;
    readonly planSnapshots: number;
    readonly insights: number;
    readonly frictionEvents: number;
    readonly diagnosticEvents: number;
    readonly repositories: number;
    readonly checkouts: number;
    readonly sessions: number;
}

export interface DashboardData {
    readonly generatedAt: string;
    readonly counts: DashboardCounts;
    readonly tableCounts: readonly Row[];
    readonly git: readonly Row[];
    readonly checkoutActivity: readonly Row[];
    readonly repositories: readonly Row[];
    readonly friction: readonly Row[];
    readonly tools: readonly Row[];
    readonly sessions: readonly Row[];
}

export interface DashboardWriteResult {
    readonly path: string;
    readonly url: string;
    readonly data: DashboardData;
}

interface DashboardOpts {
    readonly out: string | undefined;
    readonly limit: number;
}

const DEFAULT_DASHBOARD_PATH = posixPath.join(
    process.env.AX_DATA_DIR ?? posixPath.join(homedir(), ".local", "share", "ax"),
    "dashboard.html",
);

const COUNT_SQL = `
SELECT count() AS count FROM tool_call GROUP ALL;
SELECT count() AS count FROM plan_snapshot GROUP ALL;
SELECT count() AS count FROM insight GROUP ALL;
SELECT count() AS count FROM friction_event GROUP ALL;
SELECT count() AS count FROM diagnostic_event GROUP ALL;
SELECT count() AS count FROM repository GROUP ALL;
SELECT count() AS count FROM checkout GROUP ALL;
SELECT count() AS count FROM session GROUP ALL;`;

const countAt = (result: unknown[], index: number): number => {
    const rows = result[index];
    if (!Array.isArray(rows)) return 0;
    const first = rows[0] as { count?: unknown } | undefined;
    const count = Number(first?.count ?? 0);
    return Number.isFinite(count) ? count : 0;
};

const queryRows = (
    client: SurrealClientShape,
    sql: string,
): Effect.Effect<readonly Row[], DbError> =>
    Effect.gen(function* () {
        const result = yield* client.query<[Row[]]>(sql);
        return result?.[0] ?? [];
    });

export const fetchDashboardData = (
    limit: number,
): Effect.Effect<DashboardData, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const client = yield* SurrealClient;
        const [countResult, tableCounts, worktrees, repositories, friction, tools, sessions] =
            yield* Effect.all(
                [
                    client.query<unknown[]>(COUNT_SQL),
                    queryRows(client, schemaCoverageSql()),
                    // Deref-free aggregates + JS join; the legacy correlated
                    // SQL full-scanned turn/tool_call once per checkout.
                    fetchWorktreesOverview(limit),
                    queryRows(client, repositoryOverviewSql(limit)),
                    queryRows(client, recentFrictionSql(limit)),
                    queryRows(client, toolFailuresSql(limit)),
                    queryRows(client, sessionEvidenceSql(limit)),
                ],
                { concurrency: 6 },
            );
        const git = worktrees.git as DashboardData["git"];
        const checkoutActivity = worktrees.activity as DashboardData["checkoutActivity"];

        return {
            generatedAt: new Date().toISOString(),
            counts: {
                toolCalls: countAt(countResult, 0),
                planSnapshots: countAt(countResult, 1),
                insights: countAt(countResult, 2),
                frictionEvents: countAt(countResult, 3),
                diagnosticEvents: countAt(countResult, 4),
                repositories: countAt(countResult, 5),
                checkouts: countAt(countResult, 6),
                sessions: countAt(countResult, 7),
            },
            tableCounts,
            git,
            checkoutActivity,
            repositories,
            friction,
            tools,
            sessions,
        };
    });

export const writeDashboard = (
    opts: DashboardOpts,
): Effect.Effect<DashboardWriteResult, DbError, SurrealClient | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const data = yield* fetchDashboardData(opts.limit);
        const outPath = path.resolve(opts.out ?? DEFAULT_DASHBOARD_PATH);
        const html = renderDashboardHtml(data);
        // Match the original `Effect.promise` semantics: a write/mkdir failure
        // is unrecoverable here, so die rather than surface a typed error.
        yield* fs.makeDirectory(path.dirname(outPath), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(outPath, html).pipe(Effect.orDie);
        return {
            path: outPath,
            url: pathToFileURL(outPath).href,
            data,
        };
    });

const htmlEscape = (value: unknown): string =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const formatNumber = (value: number): string =>
    Number(value ?? 0).toLocaleString("en-US");

const truncate = (value: unknown, max = 120): string => {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
};

const firstScalar = (value: unknown): unknown =>
    Array.isArray(value) ? value.find((item) => item != null) : value;

const parseJsonRecord = (value: unknown): Row => {
    if (typeof value !== "string") return {};
    return (jsonRecordField.decode(value) as Row | null) ?? {};
};

const maxNumber = (rows: readonly Row[], key: string): number =>
    Math.max(1, ...rows.map((row) => Number(row[key] ?? 0)).filter(Number.isFinite));

const countTile = (label: string, value: number, tone: string): string => `
<section class="metric metric-${tone}">
  <div class="metric-label">${htmlEscape(label)}</div>
  <div class="metric-value">${formatNumber(value)}</div>
</section>`;

const schemaCoverageTable = (rows: readonly Row[]): string => {
    const populated = rows.filter((row) => Number(row.count ?? 0) > 0).length;
    return `
<section class="panel wide">
  <header><h2>Schema Coverage</h2><span>${populated}/${rows.length} populated</span></header>
  <table>
    <thead><tr><th>Table</th><th>Rows</th><th>Stage</th><th>Notes</th></tr></thead>
    <tbody>
      ${rows
          .map(
              (row) => `<tr>
                <td><code>${htmlEscape(row.table)}</code></td>
                <td>${formatNumber(Number(row.count ?? 0))}</td>
                <td><span class="stage stage-${htmlEscape(row.stage)}">${htmlEscape(row.stage)}</span></td>
                <td>${htmlEscape(row.note)}</td>
              </tr>`,
          )
          .join("")}
    </tbody>
  </table>
</section>`;
};

const repositoriesTable = (rows: readonly Row[]): string => `
<section class="panel wide">
  <header><h2>Repository Coverage</h2><span>${rows.length} visible</span></header>
  <table>
    <thead><tr><th>Repository</th><th>Checkouts</th><th>Branch</th><th>Path</th></tr></thead>
    <tbody>
      ${
          rows.length === 0
              ? `<tr><td colspan="4" class="empty">No repository evidence ingested yet.</td></tr>`
              : rows
                    .map(
                        (row) => `<tr>
                <td><strong>${htmlEscape(row.name ?? row.id)}</strong><small>${htmlEscape(row.remote_url)}</small></td>
                <td>${htmlEscape(row.checkout_count ?? 0)}</td>
                <td>${htmlEscape(firstScalar(row.checkout_branches) ?? row.default_branch)}</td>
                <td><code>${htmlEscape(truncate(row.root_path, 86))}</code></td>
              </tr>`,
                    )
                    .join("")
      }
    </tbody>
  </table>
</section>`;

const gitCorrelationTable = (rows: readonly Row[]): string => `
<section class="panel wide">
  <header><h2>Git Correlation</h2><span>${rows.length} repositories</span></header>
  <table>
    <thead><tr><th>Repository</th><th>Sessions</th><th>Produced</th><th>Commits</th><th>Touched</th></tr></thead>
    <tbody>
      ${
          rows.length === 0
              ? `<tr><td colspan="5" class="empty">No git correlation evidence ingested yet.</td></tr>`
              : rows
                    .map(
                        (row) => `<tr>
                <td><strong>${htmlEscape(row.name ?? row.id)}</strong><small>${htmlEscape(row.remote_url ?? row.root_path)}</small></td>
                <td>${htmlEscape(row.session_count ?? 0)}<small>${htmlEscape(row.checkout_linked_session_count ?? 0)} checkout-linked</small></td>
                <td>${htmlEscape(row.produced_count ?? 0)}</td>
                <td>${htmlEscape(row.commit_count ?? 0)}</td>
                <td>${htmlEscape(row.touched_count ?? 0)}</td>
              </tr>`,
                    )
                    .join("")
      }
    </tbody>
  </table>
</section>`;

const checkoutActivityTable = (rows: readonly Row[]): string => `
<section class="panel wide">
  <header><h2>Checkout Activity</h2><span>${rows.length} checkouts</span></header>
  <table>
    <thead><tr><th>Checkout</th><th>Sessions</th><th>Turns</th><th>Tools</th><th>Git Evidence</th></tr></thead>
    <tbody>
      ${
          rows.length === 0
              ? `<tr><td colspan="5" class="empty">No checkout activity evidence ingested yet.</td></tr>`
              : rows
                    .map(
                        (row) => `<tr>
                <td><strong>${htmlEscape(row.worktree_name ?? row.repository_name ?? row.id)}</strong><small>${htmlEscape(row.branch ?? "detached")} · ${htmlEscape(truncate(row.path, 96))}</small></td>
                <td>${htmlEscape(row.session_count ?? 0)}</td>
                <td>${htmlEscape(row.turn_count ?? 0)}</td>
                <td>${htmlEscape(row.tool_call_count ?? 0)}<small>${htmlEscape(row.tool_failure_count ?? 0)} failures</small></td>
                <td>${htmlEscape(row.produced_count ?? 0)} produced<small>${htmlEscape(row.touched_count ?? 0)} touched</small></td>
              </tr>`,
                    )
                    .join("")
      }
    </tbody>
  </table>
</section>`;

const toolFailures = (rows: readonly Row[]): string => {
    const max = maxNumber(rows, "failure_count");
    return `
<section class="panel">
  <header><h2>Failure Hotspots</h2><span>tool_call errors</span></header>
  <div class="bar-list">
    ${
        rows.length === 0
            ? `<div class="empty">No failing tool calls found.</div>`
            : rows
                  .map((row) => {
                      const failures = Number(row.failure_count ?? 0);
                      const width = Math.max(4, Math.round((failures / max) * 100));
                      const label = row.command_norm ?? row.name ?? "unknown";
                      return `<article class="bar-row">
              <div class="bar-meta"><strong>${htmlEscape(label)}</strong><span>${formatNumber(failures)}</span></div>
              <div class="bar-track"><div style="width:${width}%"></div></div>
              <small>exit ${htmlEscape(row.exit_code ?? "-")} · ${htmlEscape(row.last_seen ?? "unknown")}</small>
            </article>`;
                  })
                  .join("")
    }
  </div>
</section>`;
};

const frictionList = (rows: readonly Row[]): string => `
<section class="panel">
  <header><h2>Recent Friction</h2><span>latest evidence</span></header>
  <div class="event-list">
    ${
        rows.length === 0
            ? `<div class="empty">No friction events found.</div>`
            : rows
                  .map((row) => {
                      const labels = parseJsonRecord(row.labels);
                      return `<article class="event">
              <div><strong>${htmlEscape(row.kind)}</strong><time>${htmlEscape(row.ts ?? "")}</time></div>
              <p>${htmlEscape(truncate(row.text, 190))}</p>
              <small>${htmlEscape(labels.project_path ?? row.project ?? row.cwd ?? "unknown scope")}</small>
            </article>`;
                  })
                  .join("")
    }
  </div>
</section>`;

const sessionList = (rows: readonly Row[]): string => `
<section class="panel wide">
  <header><h2>Active Sessions</h2><span>tool evidence density</span></header>
  <table>
    <thead><tr><th>Session</th><th>Project</th><th>Tools</th><th>Failures</th><th>Plans</th></tr></thead>
    <tbody>
      ${
          rows.length === 0
              ? `<tr><td colspan="5" class="empty">No session evidence ingested yet.</td></tr>`
              : rows
                    .map(
                        (row) => `<tr>
                <td><code>${htmlEscape(String(row.id ?? "").replace(/^session:/, ""))}</code></td>
                <td>${htmlEscape(truncate(row.project ?? row.cwd, 80))}</td>
                <td>${htmlEscape(row.tool_call_count ?? 0)}</td>
                <td>${htmlEscape(row.tool_failure_count ?? 0)}</td>
                <td>${htmlEscape(row.plan_snapshot_count ?? 0)}</td>
              </tr>`,
                    )
                    .join("")
      }
    </tbody>
  </table>
</section>`;

export function renderDashboardHtml(data: DashboardData): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>axctl Evidence Dashboard</title>
  <style>
    :root {
      --ink: #141615;
      --muted: #66706b;
      --page: #f3f6f5;
      --line: #cfd8d4;
      --green: #16845e;
      --blue: #2567a8;
      --red: #bd443b;
      --gold: #a66d10;
      --panel: #ffffff;
      --track: #e4ebe8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        linear-gradient(90deg, rgba(20,22,21,.045) 1px, transparent 1px),
        linear-gradient(180deg, rgba(20,22,21,.045) 1px, transparent 1px),
        var(--page);
      background-size: 22px 22px;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main { max-width: 1480px; margin: 0 auto; padding: 28px; }
    .masthead {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: end;
      border-bottom: 2px solid var(--ink);
      padding-bottom: 18px;
      margin-bottom: 18px;
    }
    h1 { font-family: Georgia, serif; font-size: 42px; line-height: 1; margin: 0; font-weight: 700; }
    h2 { font-size: 15px; margin: 0; text-transform: uppercase; letter-spacing: 0; }
    .masthead p { color: var(--muted); max-width: 760px; margin: 10px 0 0; line-height: 1.5; }
    .stamp { text-align: right; color: var(--muted); font-family: Menlo, monospace; font-size: 12px; }
    .metrics { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 10px; margin-bottom: 18px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-top: 5px solid var(--ink); padding: 14px; min-height: 92px; }
    .metric-green { border-top-color: var(--green); }
    .metric-blue { border-top-color: var(--blue); }
    .metric-red { border-top-color: var(--red); }
    .metric-gold { border-top-color: var(--gold); }
    .metric-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
    .metric-value { font-family: Georgia, serif; font-size: 30px; margin-top: 10px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .panel { background: var(--panel); border: 1px solid var(--line); padding: 16px; min-height: 360px; }
    .panel.wide { grid-column: 1 / -1; min-height: 0; }
    .panel header { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 10px; margin-bottom: 10px; }
    .panel header span { color: var(--muted); font-family: Menlo, monospace; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0; padding: 8px; border-bottom: 1px solid var(--line); }
    td { padding: 10px 8px; border-bottom: 1px solid rgba(207,216,212,.74); vertical-align: top; }
    td small { display: block; color: var(--muted); margin-top: 3px; }
    code { font-family: Menlo, monospace; font-size: 12px; }
    .bar-list, .event-list { display: grid; gap: 10px; }
    .bar-row, .event { border-bottom: 1px solid rgba(207,216,212,.8); padding-bottom: 10px; }
    .bar-meta, .event div { display: flex; justify-content: space-between; gap: 12px; }
    .bar-meta span, time, .event small, .bar-row small { color: var(--muted); font-family: Menlo, monospace; font-size: 12px; }
    .bar-track { height: 9px; background: var(--track); margin: 8px 0 5px; }
    .bar-track div { height: 100%; background: var(--red); }
    .event p { margin: 8px 0 4px; line-height: 1.4; }
    .empty { color: var(--muted); font-size: 13px; padding: 18px 8px; }
    .stage { display: inline-block; min-width: 74px; border: 1px solid var(--line); padding: 3px 7px; font-size: 11px; text-transform: uppercase; text-align: center; }
    .stage-active { color: var(--green); border-color: rgba(22,132,94,.36); }
    .stage-conditional { color: var(--gold); border-color: rgba(166,109,16,.38); }
    .stage-staged { color: var(--muted); }
    @media (max-width: 980px) {
      main { padding: 16px; }
      .masthead, .grid { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stamp { text-align: left; }
    }
  </style>
</head>
<body>
  <main>
    <section class="masthead">
      <div>
        <h1>axctl Evidence Dashboard</h1>
        <p>Local Claude and Codex transcripts turned into operational evidence: repositories, sessions, tool failures, plans, imported insights, and friction signals.</p>
      </div>
      <div class="stamp">generated<br>${htmlEscape(data.generatedAt)}</div>
    </section>
    <section class="metrics">
      ${countTile("Tool Calls", data.counts.toolCalls, "blue")}
      ${countTile("Plans", data.counts.planSnapshots, "green")}
      ${countTile("Insights", data.counts.insights, "gold")}
      ${countTile("Friction", data.counts.frictionEvents, "red")}
      ${countTile("Diagnostics", data.counts.diagnosticEvents, "red")}
      ${countTile("Repos", data.counts.repositories, "blue")}
      ${countTile("Checkouts", data.counts.checkouts, "blue")}
      ${countTile("Sessions", data.counts.sessions, "green")}
    </section>
    <section class="grid">
      ${schemaCoverageTable(data.tableCounts)}
      ${gitCorrelationTable(data.git)}
      ${checkoutActivityTable(data.checkoutActivity)}
      ${repositoriesTable(data.repositories)}
      ${toolFailures(data.tools)}
      ${frictionList(data.friction)}
      ${sessionList(data.sessions)}
    </section>
  </main>
</body>
</html>`;
}
