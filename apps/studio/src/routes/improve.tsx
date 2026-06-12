import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";
import type {
    ExperimentStatus,
    ImproveActionResponse,
    ProposalDto,
    ProposalForm,
    ProposalStatus,
} from "@ax/lib/shared/dashboard-types";
import { fmtTs } from "@ax/lib/shared/formatters";
import { NextActionsPanel } from "../components/next-actions-panel.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { DecisionsSection } from "../components/decisions-section.tsx";

const ALL_FORMS: ReadonlyArray<ProposalForm | "all"> = [
    "all", "skill", "subagent", "hook", "guidance", "automation",
];
const ALL_STATUSES: ReadonlyArray<ProposalStatus | "all"> = [
    "all", "open", "accepted", "rejected", "superseded",
];
const VERDICTS: ReadonlyArray<string> = [
    "adopted", "ignored", "regressed", "partial", "no_longer_needed",
];
const CONF_W: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** Mirror of the server-side impactChip (next-actions.ts) - cheap parse only. */
const impactChipOf = (p: ProposalDto): string | null => {
    if (p.form === "hook") {
        const m = /est \$([\d,]+(?:\.\d+)?)/.exec(p.hypothesis);
        if (m) return `~$${m[1]} redirectable`;
    }
    if (p.form === "guidance" || p.form === "skill") {
        return p.frequency > 1 ? `${p.frequency}x recurring` : null;
    }
    return null;
};
const score = (p: ProposalDto) =>
    (CONF_W[p.confidence] ?? 1) * Math.log2(p.frequency + 1) +
    // agent-origin tiebreak above mined at equal confidence x frequency
    ((p.origin ?? "mined") === "agent" ? 0.5 : 0);

export function ImproveRoute() {
    const queryClient = useQueryClient();
    const [formFilter, setFormFilter] = useState<ProposalForm | "all">("all");
    const [statusFilter, setStatusFilter] = useState<ProposalStatus | "all">("open");
    const [selectedSig, setSelectedSig] = useState<string | null>(null);
    const [rejectReason, setRejectReason] = useState<string>("");
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionInfo, setActionInfo] = useState<string | null>(null);

    const query = useQuery({
        queryKey: ["improve"],
        queryFn: () => api.improve(),
    });
    const proposals = query.data?.proposals ?? [];
    const filtered = useMemo(
        () => {
            const matches = proposals.filter((p) => {
                if (formFilter !== "all" && p.form !== formFilter) return false;
                if (statusFilter !== "all" && p.status !== statusFilter) return false;
                return true;
            });
            return [...matches].sort((a, b) => score(b) - score(a));
        },
        [proposals, formFilter, statusFilter],
    );
    const selected = useMemo(
        () => filtered.find((p) => p.dedupe_sig === selectedSig) ?? filtered[0] ?? null,
        [filtered, selectedSig],
    );

    const onActionResult = (action: string, res: ImproveActionResponse) => {
        if (res.status === "ok") {
            const path = res.artifact_path ?? res.task_path;
            setActionInfo(`${action}: ok${path ? ` → ${path}` : ""}`);
            setActionError(null);
            queryClient.invalidateQueries({ queryKey: ["improve"] });
            queryClient.invalidateQueries({ queryKey: ["next-actions"] });
        } else {
            setActionError(`${action}: ${res.status}${res.message ? ` - ${res.message}` : ""}`);
            setActionInfo(null);
        }
    };

    const acceptMutation = useMutation({
        mutationFn: (sig: string) => api.improveAccept(sig),
        onSuccess: (res) => onActionResult("accept", res),
        onError: (err: Error) => { setActionError(err.message); setActionInfo(null); },
    });

    const rejectMutation = useMutation({
        mutationFn: ({ sig, reason }: { sig: string; reason: string | null }) =>
            api.improveReject(sig, reason),
        onSuccess: (res) => onActionResult("reject", res),
        onError: (err: Error) => { setActionError(err.message); setActionInfo(null); },
    });

    const verdictMutation = useMutation({
        mutationFn: ({ sig, verdict }: { sig: string; verdict: string }) =>
            api.improveSetVerdict(sig, verdict),
        onSuccess: (res) => onActionResult("verdict", res),
        onError: (err: Error) => { setActionError(err.message); setActionInfo(null); },
    });

    return (
        <section className="panel improve-route">
            <header className="improve-lead">
                <div>
                    <span className="next-action-eyebrow" style={{ color: "var(--green)" }}>
                        $ what's next
                    </span>
                    <h2 className="improve-headline">
                        <NextActionsHeadline />
                    </h2>
                    <p className="improve-sub">
                        Mined from your sessions - savings to route, fixes that recur, verdicts due.
                    </p>
                </div>
                <AnalysisBriefButton />
            </header>

            <NextActionsPanel handlers={{
                onAccept: (sig) => acceptMutation.mutate(sig),
                onVerdict: (sig, v) => verdictMutation.mutate({ sig, verdict: v }),
                pending: acceptMutation.isPending || rejectMutation.isPending || verdictMutation.isPending,
            }} />

            {query.error ? <div className="error">Error: {String(query.error)}</div> : null}
            {actionError ? <div className="error">{actionError}</div> : null}
            {actionInfo ? <div className="empty" style={{ color: "var(--green)" }}>{actionInfo}</div> : null}

            <div className="improve-registry-head">
                <h3>All proposals</h3>
                <span className="meta" title="Ranked by confidence × frequency - click a row for details">
                    {proposals.length} proposals · {filtered.length} shown
                </span>
                <div className="filters">
                    <label>
                        form{" "}
                        <select value={formFilter} onChange={(e) => setFormFilter(e.target.value as ProposalForm | "all")}>
                            {ALL_FORMS.map((f) => (<option key={f} value={f}>{f}</option>))}
                        </select>
                    </label>
                    <label>
                        status{" "}
                        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ProposalStatus | "all")}>
                            {ALL_STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
                        </select>
                    </label>
                </div>
            </div>

            {query.isLoading ? <div className="loading">Loading…</div> : null}

            {!query.isLoading && filtered.length === 0 ? (
                <div className="empty">No proposals match the current filters.</div>
            ) : null}

            <div className="improve-grid">
                <table className="skills">
                    <thead>
                        <tr>
                            <th>Freq</th>
                            <th>Form</th>
                            <th>Status</th>
                            <th>Exp. Status</th>
                            <th>Verdict</th>
                            <th>Title</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((p) => {
                            const verdict = p.experiment?.locked_verdict
                                ? `locked: ${p.experiment.locked_verdict}`
                                : p.experiment?.latest_checkpoint?.suggested
                                    ? `suggested: ${p.experiment.latest_checkpoint.suggested}`
                                    : p.status === "accepted" ? "pending"
                                    : "-";
                            return (
                                <tr
                                    key={p.dedupe_sig}
                                    onClick={() => setSelectedSig(p.dedupe_sig)}
                                    style={{
                                        cursor: "pointer",
                                        background: selected?.dedupe_sig === p.dedupe_sig ? "rgba(0,0,0,0.05)" : undefined,
                                    }}
                                >
                                    <td style={{ textAlign: "right" }}>{p.frequency}</td>
                                    <td>{p.form}</td>
                                    <td><StatusPill status={p.status} /></td>
                                    <td>{p.experiment?.status
                                        ? <ExperimentStatusBadge status={p.experiment.status} />
                                        : <span className="meta">-</span>}
                                    </td>
                                    <td>{verdict}</td>
                                    <td>
                                        {(p.origin ?? "mined") === "agent"
                                            ? <span className="badge keep" style={{ marginRight: 6 }}>agent</span>
                                            : null}
                                        {p.title}
                                        {impactChipOf(p) ? (
                                            <span className="next-action-impact" style={{ marginLeft: 8 }}>
                                                {impactChipOf(p)}
                                            </span>
                                        ) : null}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>

                <aside className="panel" style={{ position: "sticky", top: 16, alignSelf: "flex-start" }}>
                    {selected ? (
                        <ProposalDetail
                            proposal={selected}
                            rejectReason={rejectReason}
                            onRejectReason={setRejectReason}
                            onAccept={() => acceptMutation.mutate(selected.dedupe_sig)}
                            onReject={() => rejectMutation.mutate({ sig: selected.dedupe_sig, reason: rejectReason || null })}
                            onSetVerdict={(verdict) => verdictMutation.mutate({ sig: selected.dedupe_sig, verdict })}
                            pending={acceptMutation.isPending || rejectMutation.isPending || verdictMutation.isPending}
                        />
                    ) : (
                        <div className="empty">Select a proposal to see details, accept it, or set a verdict.</div>
                    )}
                </aside>
            </div>

            <details style={{ marginTop: 24 }}>
                <summary style={{ cursor: "pointer" }}><strong>Decision log</strong></summary>
                <DecisionsSection />
            </details>
        </section>
    );
}

function StatusPill({ status }: { status: string }) {
    const cls = status === "open" ? "keep" : status === "rejected" ? "archive" : "review";
    return <span className={`badge ${cls}`}>{status}</span>;
}

function ExperimentStatusBadge({ status }: { status: ExperimentStatus | string }) {
    const cls =
        status === "task_emitted" ? "review"
        : status === "scaffolded" ? "keep"
        : status === "regressed" ? "archive"
        : status === "retired" ? "archive"
        : "review";
    return <span className={`badge ${cls}`}>{status}</span>;
}

interface ProposalDetailProps {
    readonly proposal: ProposalDto;
    readonly rejectReason: string;
    readonly onRejectReason: (v: string) => void;
    readonly onAccept: () => void;
    readonly onReject: () => void;
    readonly onSetVerdict: (verdict: string) => void;
    readonly pending: boolean;
}

function ProposalDetail({
    proposal,
    rejectReason,
    onRejectReason,
    onAccept,
    onReject,
    onSetVerdict,
    pending,
}: ProposalDetailProps) {
    const exp = proposal.experiment ?? null;
    const cp = exp?.latest_checkpoint ?? null;
    return (
        <>
            <header>
                <h3 style={{ margin: 0 }}>{proposal.title}</h3>
                <span className="meta">{proposal.dedupe_sig} · {proposal.origin ?? "mined"}</span>
            </header>
            <dl className="kv">
                <dt>Form</dt><dd>{proposal.form}</dd>
                <dt>Status</dt><dd><StatusPill status={proposal.status} /></dd>
                <dt>Confidence</dt><dd>{proposal.confidence}</dd>
                <dt>Frequency</dt><dd>{proposal.frequency}</dd>
                <dt>Created</dt><dd>{fmtTs(proposal.created_at)}</dd>
                <dt>Hypothesis</dt><dd>{proposal.hypothesis}</dd>
                {proposal.reject_reason ? (<><dt>Reject reason</dt><dd>{proposal.reject_reason}</dd></>) : null}
            </dl>

            <PayloadView proposal={proposal} />

            {exp ? (
                <section className="panel" style={{ marginTop: 12 }}>
                    <header>
                        <h4 style={{ margin: 0 }}>Experiment</h4>
                        <span className="meta">{fmtTs(exp.created_at)}</span>
                    </header>
                    <dl className="kv">
                        {exp.status ? (<><dt>Exp. Status</dt><dd><ExperimentStatusBadge status={exp.status} /></dd></>) : null}
                        {exp.artifact_path ? (<><dt>Artifact</dt><dd><code>{exp.artifact_path}</code></dd></>) : null}
                        {exp.task_path && exp.status === "task_emitted"
                            ? (<><dt>Task path</dt><dd>{exp.task_path}</dd></>) : null}
                        {exp.scaffolded_at ? (<><dt>Scaffolded</dt><dd>{fmtTs(exp.scaffolded_at)}</dd></>) : null}
                        <dt>Verdict</dt><dd>
                            {exp.locked_verdict
                                ? <strong>{exp.locked_verdict} (locked)</strong>
                                : cp?.suggested
                                    ? <em>{cp.suggested} (suggested @ {cp.kind})</em>
                                    : "pending - no checkpoint yet"}
                        </dd>
                        {cp?.measured ? (
                            <>
                                <dt>Opportunities</dt>
                                <dd>{cp.measured.opportunities} ({cp.measured.addressed} addressed)</dd>
                            </>
                        ) : null}
                    </dl>
                </section>
            ) : null}

            <div className="actions" style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {proposal.brief ? <CopyButton text={proposal.brief} /> : null}
                {proposal.status === "open" ? (
                    <>
                        <button
                            type="button"
                            className="badge keep"
                            disabled={pending}
                            onClick={onAccept}
                        >Accept & scaffold</button>
                        <input
                            type="text"
                            placeholder="reject reason (optional)"
                            value={rejectReason}
                            onChange={(e) => onRejectReason(e.target.value)}
                            style={{ flex: 1, minWidth: 200 }}
                        />
                        <button
                            type="button"
                            className="badge archive"
                            disabled={pending}
                            onClick={onReject}
                        >Reject</button>
                    </>
                ) : proposal.status === "accepted" && exp && !exp.locked_verdict ? (
                    <>
                        <span className="meta">Lock verdict:</span>
                        {VERDICTS.map((v) => (
                            <button
                                key={v}
                                type="button"
                                className="badge review"
                                disabled={pending}
                                onClick={() => onSetVerdict(v)}
                            >{v}</button>
                        ))}
                    </>
                ) : (
                    <span className="meta">No actions available for status={proposal.status}.</span>
                )}
            </div>
        </>
    );
}

function PayloadView({ proposal }: { proposal: ProposalDto }) {
    if (proposal.form === "skill" && proposal.skill_payload) {
        return (
            <section className="panel" style={{ marginTop: 12 }}>
                <header><h4 style={{ margin: 0 }}>Skill payload</h4></header>
                <dl className="kv">
                    <dt>Trigger</dt><dd>{proposal.skill_payload.trigger_pattern}</dd>
                    <dt>Gap</dt><dd>{proposal.skill_payload.suspected_gap}</dd>
                    <dt>Behavior</dt><dd>{proposal.skill_payload.proposed_behavior}</dd>
                    {proposal.skill_payload.expected_impact
                        ? (<><dt>Impact</dt><dd>{proposal.skill_payload.expected_impact}</dd></>)
                        : null}
                </dl>
            </section>
        );
    }
    if (proposal.form === "guidance" && proposal.guidance_payload) {
        return (
            <section className="panel" style={{ marginTop: 12 }}>
                <header><h4 style={{ margin: 0 }}>Guidance payload</h4></header>
                <dl className="kv">
                    <dt>Target</dt><dd><code>{proposal.guidance_payload.file_target}</code></dd>
                    {proposal.guidance_payload.section
                        ? (<><dt>Section</dt><dd>{proposal.guidance_payload.section}</dd></>) : null}
                    <dt>Text</dt><dd>{proposal.guidance_payload.suggested_text}</dd>
                </dl>
            </section>
        );
    }
    if (proposal.form === "subagent" && proposal.subagent_payload) {
        return (
            <section className="panel" style={{ marginTop: 12 }}>
                <header><h4 style={{ margin: 0 }}>Subagent payload</h4></header>
                <dl className="kv">
                    <dt>Role</dt><dd>{proposal.subagent_payload.bounded_role}</dd>
                    <dt>Delegation</dt><dd>{proposal.subagent_payload.delegation_trigger}</dd>
                </dl>
            </section>
        );
    }
    if (proposal.form === "hook" && proposal.hook_payload) {
        return (
            <section className="panel" style={{ marginTop: 12 }}>
                <header><h4 style={{ margin: 0 }}>Hook payload</h4></header>
                <dl className="kv">
                    <dt>Event</dt><dd>{proposal.hook_payload.event_name}</dd>
                    <dt>Tool</dt><dd>{proposal.hook_payload.target_tool ?? "-"}</dd>
                    <dt>Command</dt><dd><code>{proposal.hook_payload.hook_command}</code></dd>
                    <SafetyFields payload={proposal.hook_payload} />
                </dl>
            </section>
        );
    }
    if (proposal.form === "automation" && proposal.automation_payload) {
        return (
            <section className="panel" style={{ marginTop: 12 }}>
                <header><h4 style={{ margin: 0 }}>Automation payload</h4></header>
                <dl className="kv">
                    <dt>Trigger</dt><dd>{proposal.automation_payload.trigger_signal}</dd>
                    <dt>Schedule</dt><dd>{proposal.automation_payload.schedule ?? "-"}</dd>
                    <dt>Action</dt><dd><code>{proposal.automation_payload.action}</code></dd>
                    <SafetyFields payload={proposal.automation_payload} />
                </dl>
            </section>
        );
    }
    return null;
}

function SafetyFields({
    payload,
}: {
    payload: {
        readonly recovery_path: string | null;
        readonly smoke_test_command: string | null;
        readonly disable_command: string | null;
        readonly failure_mode: string | null;
    };
}) {
    const missing = [
        payload.recovery_path ? null : "Recovery Path",
        payload.smoke_test_command ? null : "smoke test",
        payload.disable_command ? null : "disable switch",
        payload.failure_mode === "fail_open" || payload.failure_mode === "fail_closed" ? null : "failure mode",
    ].filter((item): item is string => item !== null);
    return (
        <>
            <dt>Safety</dt><dd>{missing.length > 0 ? `missing: ${missing.join(", ")}` : "complete"}</dd>
            <dt>Recovery</dt><dd>{payload.recovery_path ?? "-"}</dd>
            <dt>Smoke test</dt><dd>{payload.smoke_test_command ?? "-"}</dd>
            <dt>Disable</dt><dd>{payload.disable_command ?? "-"}</dd>
            <dt>Failure mode</dt><dd>{payload.failure_mode ?? "-"}</dd>
        </>
    );
}

/** Fetches the deep-analysis brief once and offers it as a copy action -
 *  paste into an agent session; findings return via `ax improve propose`. */
function AnalysisBriefButton() {
    const query = useQuery({
        queryKey: ["improve", "analyze-brief"],
        queryFn: () => api.improveAnalyzeBrief(),
        staleTime: Infinity,
    });
    if (!query.data) return null;
    return <CopyButton text={query.data.brief} label="Copy analysis brief" />;
}

/** Serif lead: counts what the loop found (shares the cached next-actions query). */
function NextActionsHeadline() {
    const query = useQuery({
        queryKey: ["next-actions"],
        queryFn: () => api.nextActions(),
        staleTime: 60_000,
    });
    const n = query.data?.cards.length;
    return <>{n === undefined ? "What's next" : `${n} actions waiting`}</>;
}
