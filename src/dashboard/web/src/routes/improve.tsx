import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";
import type {
    ExperimentStatus,
    ImproveActionResponse,
    ProposalDto,
    ProposalForm,
    ProposalStatus,
} from "@shared/dashboard-types.ts";
import { fmtTs } from "@shared/formatters.ts";

const ALL_FORMS: ReadonlyArray<ProposalForm | "all"> = [
    "all", "skill", "subagent", "hook", "guidance", "automation",
];
const ALL_STATUSES: ReadonlyArray<ProposalStatus | "all"> = [
    "all", "open", "accepted", "rejected", "superseded",
];
const VERDICTS: ReadonlyArray<string> = [
    "adopted", "ignored", "regressed", "partial", "no_longer_needed",
];

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
        () =>
            proposals.filter((p) => {
                if (formFilter !== "all" && p.form !== formFilter) return false;
                if (statusFilter !== "all" && p.status !== statusFilter) return false;
                return true;
            }),
        [proposals, formFilter, statusFilter],
    );
    const selected = useMemo(
        () => proposals.find((p) => p.dedupe_sig === selectedSig) ?? null,
        [proposals, selectedSig],
    );

    const onActionResult = (action: string, res: ImproveActionResponse) => {
        if (res.status === "ok") {
            const path = res.artifact_path ?? res.task_path;
            setActionInfo(`${action}: ok${path ? ` → ${path}` : ""}`);
            setActionError(null);
            queryClient.invalidateQueries({ queryKey: ["improve"] });
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
            <header>
                <h2>Experiment Loop</h2>
                <span className="meta">
                    {proposals.length} proposals · {filtered.length} shown
                </span>
            </header>

            {query.error ? <div className="error">Error: {String(query.error)}</div> : null}
            {actionError ? <div className="error">{actionError}</div> : null}
            {actionInfo ? <div className="empty" style={{ color: "#1d6f3d" }}>{actionInfo}</div> : null}

            <div className="filter-bar" style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
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
                <span className="meta">
                    Ranked by frequency · click a row for details
                </span>
            </div>

            {query.isLoading ? <div className="loading">Loading…</div> : null}

            {!query.isLoading && filtered.length === 0 ? (
                <div className="empty">No proposals match the current filters.</div>
            ) : null}

            <div className="improve-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 480px)", gap: 16 }}>
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
                                        background: selectedSig === p.dedupe_sig ? "rgba(0,0,0,0.05)" : undefined,
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
                                    <td>{p.title}</td>
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
                <span className="meta">{proposal.dedupe_sig}</span>
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
    return null;
}
