import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";
import type { SkillTriageNote, TriageDecision } from "@ax/lib/shared/dashboard-types";
import { fmtTs } from "@ax/lib/shared/formatters";

export function DecisionsRoute() {
    const queryClient = useQueryClient();
    const decisionsQuery = useQuery({
        queryKey: ["decisions"],
        queryFn: () => api.decisions().then((r) => r.decisions),
    });
    const notes = decisionsQuery.data ?? [];
    const loading = decisionsQuery.isLoading;
    const [actionError, setError] = useState<string | null>(null);
    const error =
        actionError ?? (decisionsQuery.error ? String(decisionsQuery.error) : null);
    const [pending, setPending] = useState<string | null>(null);

    const setNotes = (
        updater: (
            curr: ReadonlyArray<SkillTriageNote>,
        ) => ReadonlyArray<SkillTriageNote>,
    ): void => {
        queryClient.setQueryData<ReadonlyArray<SkillTriageNote>>(
            ["decisions"],
            (curr) => updater(curr ?? []),
        );
        // Triage view also depends on decisions; invalidate so it re-syncs
        // next time it's visible.
        queryClient.invalidateQueries({ queryKey: ["skills"] });
    };

    const undo = async (name: string) => {
        setPending(name);
        try {
            await api.clearDecision(name);
            setNotes((curr) => curr.filter((n) => n.skill_name !== name));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(null);
        }
    };

    const change = async (name: string, decision: TriageDecision) => {
        setPending(name);
        try {
            const note = await api.decide(name, decision);
            setNotes((curr) =>
                curr.map((n) => (n.skill_name === name ? note : n)),
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(null);
        }
    };

    return (
        <section className="panel">
            <header>
                <h2>Decision Log</h2>
                <span className="meta">
                    {notes.length} active
                    {notes.length > 0 ? ` · most recent ${fmtTs(notes[0]?.decided_at)}` : ""}
                </span>
            </header>

            {error ? <div className="error">Error: {error}</div> : null}
            {loading ? <div className="loading">Loading…</div> : null}

            {!loading && notes.length === 0 ? (
                <div className="empty">No decisions recorded yet.</div>
            ) : null}

            {notes.length > 0 ? (
                <table className="skills">
                    <thead>
                        <tr>
                            <th>Skill</th>
                            <th>Decision</th>
                            <th>Decided</th>
                            <th>Reason</th>
                            <th>Change</th>
                        </tr>
                    </thead>
                    <tbody>
                        {notes.map((note) => (
                            <tr key={note.skill_name}>
                                <td>
                                    <Link
                                        to="/skills"
                                        search={{ q: note.skill_name }}
                                        title="open in Skill Triage"
                                    >
                                        <strong>{note.skill_name}</strong>
                                    </Link>
                                </td>
                                <td>
                                    <span className={`badge ${note.decision}`}>
                                        {note.decision}
                                    </span>
                                </td>
                                <td>{fmtTs(note.decided_at)}</td>
                                <td>
                                    <small>{note.reason ?? "-"}</small>
                                </td>
                                <td>
                                    <div className="actions">
                                        {(["keep", "review", "archive"] as TriageDecision[]).map(
                                            (d) => (
                                                <button
                                                    key={d}
                                                    type="button"
                                                    disabled={pending === note.skill_name}
                                                    className={
                                                        d === note.decision ? "is-active" : undefined
                                                    }
                                                    onClick={() => change(note.skill_name, d)}
                                                >
                                                    {d}
                                                </button>
                                            ),
                                        )}
                                        <button
                                            type="button"
                                            disabled={pending === note.skill_name}
                                            onClick={() => undo(note.skill_name)}
                                            title="clear this decision"
                                        >
                                            undo
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}
        </section>
    );
}
