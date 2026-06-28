import { formatCompact, type StateReport } from "@ax/lib/shared/community";
import {
    STATE_MIN_USERS,
    hasEnoughStateUsers,
    stateRows,
    topStateRows,
    type StateRow,
} from "../lib/state-report";

const pctFmt = new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 0,
});

function fmtPct(share: number): string {
    return pctFmt.format(Math.max(0, Math.min(1, share)));
}

function displaySkill(label: string): { readonly source: string | null; readonly name: string } {
    const sep = label.indexOf(":");
    if (sep === -1) return { source: null, name: label };
    const source = label.slice(0, sep);
    const rest = label.slice(sep + 1);
    return { source, name: rest.startsWith(`${source}:`) ? rest.slice(source.length + 1) : rest };
}

export function StateReportDossier({
    report,
    minUsers = STATE_MIN_USERS,
}: {
    readonly report: StateReport;
    readonly minUsers?: number;
}) {
    if (!hasEnoughStateUsers(report, minUsers)) {
        return <StateReportTeaser report={report} minUsers={minUsers} />;
    }

    const harnessRows = stateRows(report.harness_mix, report.users);
    const modelRows = stateRows(report.model_share, report.users);
    const skillRows = topStateRows(report.skill_adoption, 20, report.users);
    const skillTotal = Object.keys(report.skill_adoption).length;

    return (
        <article className="state-report-doc">
            <header className="st-hero">
                <p className="st-eyebrow">state of agent engineering / {report.year}</p>
                <h1>State of Agent Engineering {report.year}</h1>
                <p className="st-lede">
                    <strong>measured, not asked</strong> - a field report compiled from public opt-in
                    ax profiles, not survey recall.
                </p>
                <div className="st-vitals" aria-label="report vitals">
                    <Vital value={formatCompact(report.users)} label="registered builders" />
                    <Vital value={formatCompact(harnessRows.length)} label="harnesses observed" />
                    <Vital value={formatCompact(modelRows.length)} label="models observed" />
                    <Vital value={formatCompact(skillTotal)} label="skills observed" />
                </div>
            </header>

            <section className="st-method">
                <p>
                    Survey reports ask what people remember using. This page counts what their local
                    coding agents actually emitted into ax: harnesses, models, and skills aggregated
                    into anonymous distributions.
                </p>
            </section>

            <section className="st-chart-grid" aria-label="observed distributions">
                <StateBarChart title="Harness mix" note="builders with each harness in their published window" rows={harnessRows} accent="green" />
                <StateBarChart title="Model share" note="builders with each model represented" rows={modelRows} accent="blue" />
            </section>

            <section className="st-section" aria-labelledby="skill-adoption-heading">
                <div className="st-section-head">
                    <p className="st-eyebrow">adoption curve</p>
                    <h2 id="skill-adoption-heading">Skill adoption top 20</h2>
                    <p>
                        Ranked by distinct builders, capped at twenty so early one-off skills do not
                        overwhelm the shared signal.
                    </p>
                </div>
                <ol className="st-skill-chart">
                    {skillRows.map((row, index) => {
                        const skill = displaySkill(row.label);
                        const max = Math.max(1, skillRows[0]?.count ?? 1);
                        return (
                            <li className="st-skill-row" key={row.label}>
                                <span className="st-rank">{index + 1}</span>
                                <span className="st-skill-name">
                                    {skill.source && <span className="st-source">{skill.source}</span>}
                                    {skill.name}
                                </span>
                                <span className="st-bar st-bar--skill" aria-hidden>
                                    <span style={{ width: `${Math.max(3, (row.count / max) * 100)}%` }} />
                                </span>
                                <span className="st-count">{formatCompact(row.count)} builders</span>
                            </li>
                        );
                    })}
                </ol>
            </section>
        </article>
    );
}

function StateReportTeaser({
    report,
    minUsers,
}: {
    readonly report: StateReport;
    readonly minUsers: number;
}) {
    return (
        <article className="state-report-doc state-report-doc--teaser">
            <section className="st-teaser">
                <p className="st-eyebrow">Founding sample</p>
                <h1>State of Agent Engineering {report.year}</h1>
                <p className="st-lede">
                    <strong>measured, not asked</strong> - the report unlocks once at least{" "}
                    <strong>{formatCompact(minUsers)}</strong> registered builders have published profiles.
                </p>
                <p className="st-teaser-copy">
                    Current sample: <strong>{formatCompact(report.users)}</strong> of{" "}
                    <strong>{formatCompact(minUsers)}</strong>. Holding the charts back keeps a tiny
                    founding cohort from pretending to be an industry benchmark.
                </p>
                <div className="st-teaser-actions">
                    <code>ax profile publish</code>
                    <a href="/leaders">join the public board</a>
                </div>
            </section>
        </article>
    );
}

function StateBarChart({
    title,
    note,
    rows,
    accent,
}: {
    readonly title: string;
    readonly note: string;
    readonly rows: readonly StateRow[];
    readonly accent: "green" | "blue";
}) {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return (
        <section className="st-chart" data-accent={accent}>
            <div className="st-chart-head">
                <h2>{title}</h2>
                <p>{note}</p>
            </div>
            <ol className="st-bars">
                {rows.map((row) => (
                    <li key={row.label}>
                        <span className="st-label" title={row.label}>{row.label}</span>
                        <span className="st-bar" aria-hidden>
                            <span style={{ width: `${Math.max(3, (row.count / max) * 100)}%` }} />
                        </span>
                        <span className="st-count">
                            {formatCompact(row.count)}
                            <small>{fmtPct(row.share)}</small>
                        </span>
                    </li>
                ))}
            </ol>
        </section>
    );
}

function Vital({ value, label }: { readonly value: string; readonly label: string }) {
    return (
        <div className="st-vital">
            <span className="st-vital-value">{value}</span>
            <span className="st-vital-label">{label}</span>
        </div>
    );
}
