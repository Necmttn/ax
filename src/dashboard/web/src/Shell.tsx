import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";
import { useIngestEvents } from "./use-ingest-events.ts";
import { fmtLastUsed } from "@shared/formatters.ts";

interface Tab {
    readonly to:
        | "/skills"
        | "/skills/graph"
        | "/tools"
        | "/decisions"
        | "/workflow"
        | "/recall"
        | "/wrapped";
    readonly label: string;
    readonly prefetch: () => Promise<unknown>;
}

export function Shell({ children }: { children: ReactNode }) {
    const state = useRouterState();
    const path = state.location.pathname;
    const queryClient = useQueryClient();
    const live = useIngestEvents();

    const TABS: ReadonlyArray<Tab> = [
        {
            to: "/workflow",
            label: "Workflow",
            prefetch: () =>
                queryClient.prefetchQuery({
                    queryKey: ["workflow"],
                    queryFn: () => api.workflow(),
                }),
        },
        {
            to: "/skills",
            label: "Skills",
            prefetch: () =>
                queryClient.prefetchQuery({
                    queryKey: ["skills"],
                    queryFn: () => api.skills(),
                }),
        },
        {
            to: "/skills/graph",
            label: "Graph",
            prefetch: () =>
                queryClient.prefetchQuery({
                    queryKey: ["skill-graph", 10],
                    queryFn: () => api.skillGraph({ minCount: 10, limit: 400 }),
                }),
        },
        {
            to: "/tools",
            label: "Tools",
            prefetch: () =>
                queryClient.prefetchQuery({
                    queryKey: ["tool-failures"],
                    queryFn: () => api.toolFailures(),
                }),
        },
        {
            to: "/decisions",
            label: "Decisions",
            prefetch: () =>
                queryClient.prefetchQuery({
                    queryKey: ["decisions"],
                    queryFn: () => api.decisions().then((r) => r.decisions),
                }),
        },
        {
            to: "/recall",
            label: "Recall",
            prefetch: () => Promise.resolve(undefined),
        },
        {
            to: "/wrapped",
            label: "Wrapped",
            prefetch: () =>
                Promise.all([
                    queryClient.prefetchQuery({
                        queryKey: ["wrapped"],
                        queryFn: () => api.wrapped(),
                    }),
                    queryClient.prefetchQuery({
                        queryKey: ["wrapped", "public-preview"],
                        queryFn: () => api.wrappedPublicPreview(),
                    }),
                ]),
        },
    ];

    return (
        <div className="shell">
            <header className="masthead">
                <h1>ax</h1>
                <span
                    className={`live-indicator ${live.connected ? "on" : "off"}`}
                    title={
                        live.lastEventAt
                            ? `last ingest ${fmtLastUsed(live.lastEventAt)}`
                            : live.connected
                            ? "connected, no events yet"
                            : "disconnected"
                    }
                >
                    <span className="live-dot" />
                    {live.connected ? "live" : "offline"}
                </span>
                <nav className="tabs">
                    {TABS.map((tab) => {
                        const active =
                            path === tab.to || (tab.to === "/skills" && path === "/");
                        return (
                            <Link
                                key={tab.to}
                                to={tab.to}
                                className={active ? "active" : undefined}
                                onMouseEnter={() => void tab.prefetch()}
                                onFocus={() => void tab.prefetch()}
                            >
                                {tab.label}
                            </Link>
                        );
                    })}
                </nav>
            </header>
            {children}
        </div>
    );
}
