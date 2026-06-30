import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RunEvidencePayload } from "@ax/lib/shared/dashboard-types";
import { RunEvidencePanel } from "./session-inspect.tsx";

const payload = (over: Partial<RunEvidencePayload>): RunEvidencePayload => ({
    session_id: "s1",
    generated_at: "2026-07-01T00:00:00.000Z",
    objective: null,
    repo: null,
    total: 0,
    by_kind: [],
    by_backing: [],
    timeline: [],
    ref_total: 0,
    by_ref_kind: [],
    covered_kinds: [],
    timeline_limit: 50,
    ...over,
});

const render = (sessionId: string, data: RunEvidencePayload): string => {
    const qc = new QueryClient();
    qc.setQueryData(["run-evidence", sessionId], data);
    return renderToStaticMarkup(
        <QueryClientProvider client={qc}>
            <RunEvidencePanel sessionId={sessionId} />
        </QueryClientProvider>,
    );
};

test("renders objective + repo headlines + kind/backing counts + ref count", () => {
    const html = render("s1", payload({
        total: 5,
        objective: "Add omp harness support",
        repo: "Necmttn/ax @ feat/636 · a1b2c3d",
        by_kind: [{ key: "tool_observation", count: 4 }, { key: "objective", count: 1 }],
        by_backing: [{ key: "tool_backed", count: 4 }, { key: "model_claim", count: 0 }],
        ref_total: 2,
        by_ref_kind: [{ key: "file", count: 2 }],
    }));
    expect(html).toContain("run evidence");
    expect(html).toContain("Add omp harness support");
    expect(html).toContain("Necmttn/ax @ feat/636 · a1b2c3d");
    expect(html).toContain("tool_observation 4");
    expect(html).toContain("tool_backed 4");
    expect(html).toContain("2 refs");
    expect(html).toContain("model_claim 0");
});

test("renders nothing when the session has no run-evidence events", () => {
    const html = render("s2", payload({ total: 0 }));
    expect(html).toBe("");
});
