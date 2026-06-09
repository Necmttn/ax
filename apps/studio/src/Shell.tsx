import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, studioConnection, type DaemonVersion } from "./api.ts";
import { useIngestEvents } from "./use-ingest-events.ts";
import { fmtLastUsed } from "@ax/lib/shared/formatters";
import { cmpSemver, STUDIO_VERSION } from "./version.ts";

const STUDIO_MOCK = import.meta.env.VITE_STUDIO_MOCK === "true";
const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:1738";
// Min api_version the studio expects. Bump when the studio starts
// relying on a new endpoint or breaking field rename.
const STUDIO_MIN_API_VERSION = 1;

interface Tab {
    readonly to:
        | "/skills"
        | "/skills/graph"
        | "/graph"
        | "/canvas"
        | "/tools"
        | "/decisions"
        | "/workflow"
        | "/recall"
        | "/sessions"
        | "/wrapped"
        | "/improve"
        | "/ingest-live";
    readonly label: string;
    readonly prefetch: () => Promise<unknown>;
}

export function Shell({ children }: { children: ReactNode }) {
    const state = useRouterState();
    // A shared session (/share/...) is a standalone, read-only gist view: the
    // local-graph nav + live/offline chrome don't apply (those routes need a
    // running daemon). Render slim branded chrome with a CTA instead. Branching
    // on which component renders keeps each one's hooks unconditional.
    return state.location.pathname.startsWith("/share")
        ? <ShareChrome>{children}</ShareChrome>
        : <FullChrome>{children}</FullChrome>;
}

/** Slim chrome for a standalone shared-session gist view. */
function ShareChrome({ children }: { children: ReactNode }) {
    return (
        <div className="shell">
            <header className="masthead masthead-share">
                <div className="brand">
                    <h1>ax</h1>
                    <span className="brand-tag">agent experience</span>
                </div>
                <a
                    className="share-cta"
                    href="https://ax.necmttn.com"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    Map your own agent sessions → Get ax
                </a>
            </header>
            {children}
        </div>
    );
}

function FullChrome({ children }: { children: ReactNode }) {
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
            to: "/sessions",
            label: "Sessions",
            prefetch: () =>
                queryClient.prefetchQuery({
                    queryKey: ["sessions", "all"],
                    queryFn: () => api.sessions({ limit: 200 }),
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
            to: "/canvas",
            label: "Canvas",
            prefetch: () =>
                queryClient.prefetchQuery({
                    queryKey: ["session-canvas"],
                    queryFn: () => api.sessionCanvas({ limit: 800 }),
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
            to: "/improve",
            label: "Improve",
            prefetch: () =>
                queryClient.prefetchQuery({
                    queryKey: ["improve"],
                    queryFn: () => api.improve(),
                }),
        },
        {
            to: "/recall",
            label: "Recall",
            prefetch: () => Promise.resolve(undefined),
        },
        {
            to: "/ingest-live",
            label: "Live",
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
            {STUDIO_MOCK ? <StudioBanner /> : null}
            <header className="masthead">
                <div className="brand">
                    <h1>ax</h1>
                    <span className="brand-tag">agent experience</span>
                </div>
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

/**
 * Studio-only banner.
 * - When no live connection: invites the user to point at their local
 *   `axctl serve`. Try-connect probes /api/skills with CORS.
 * - When connected: shows the endpoint + disconnect.
 */
function StudioBanner() {
    const initialEndpoint = studioConnection.endpoint;
    const [endpoint, setEndpoint] = useState<string | null>(initialEndpoint);
    const [input, setInput] = useState<string>(DEFAULT_LOCAL_ENDPOINT);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (endpoint) {
        return <LiveBanner endpoint={endpoint} onDisconnect={() => {
            studioConnection.clear();
            setEndpoint(null);
            window.location.reload();
        }} />;
    }

    const connect = async () => {
        setBusy(true);
        setError(null);
        const target = input.trim().replace(/\/$/, "");
        const ok = await studioConnection.probe(target);
        if (!ok) {
            setBusy(false);
            setError(`Could not reach ${target}/api/skills. Is \`axctl serve\` running? Did CORS land?`);
            return;
        }
        studioConnection.set(target);
        window.location.reload();
    };

    return (
        <div className="studio-banner">
            <strong>Mock-mode preview.</strong>
            <span>
                Run <code>axctl serve</code> locally and connect to see your real graph:
            </span>
            <input
                className="banner-input"
                type="url"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={busy}
                aria-label="local axctl serve endpoint"
            />
            <button type="button" className="banner-btn primary" onClick={connect} disabled={busy}>
                {busy ? "Connecting…" : "Connect →"}
            </button>
            {error ? <small className="banner-error">{error}</small> : null}
        </div>
    );
}

/** Live banner - fetches /api/version on mount, shows daemon version
 *  and nags if api_version is older than the studio expects. */
function LiveBanner({ endpoint, onDisconnect }: { endpoint: string; onDisconnect: () => void }) {
    const [info, setInfo] = useState<DaemonVersion | null>(null);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        api.version().then(
            (v) => { if (!cancelled) setInfo(v); },
            (e: Error) => { if (!cancelled) setErr(e.message); },
        );
        return () => { cancelled = true; };
    }, [endpoint]);

    const apiBehind = info != null && info.api_version < STUDIO_MIN_API_VERSION;
    // Compare the connected daemon's release version against this studio bundle's.
    // <0: daemon older than studio (update the daemon); >0: studio bundle stale.
    const verDelta = info != null ? cmpSemver(info.version, STUDIO_VERSION) : 0;
    const warn = apiBehind || verDelta !== 0;
    const className = warn
        ? "studio-banner studio-banner-warn"
        : "studio-banner studio-banner-live";

    return (
        <div className={className}>
            <strong>{warn ? "Update." : "Live."}</strong>
            <span>
                Connected to <code>{endpoint}</code>
                {info ? <> · ax v{info.version} (api v{info.api_version})</> : null}
                {" · studio v"}{STUDIO_VERSION}
                {verDelta < 0
                    ? <> · daemon is behind studio - run <code>axctl update</code></>
                    : null}
                {verDelta > 0
                    ? <> · studio bundle is stale (v{STUDIO_VERSION} &lt; daemon v{info!.version}) - hard-refresh</>
                    : null}
                {apiBehind ? <> · studio expects api v{STUDIO_MIN_API_VERSION}+</> : null}
                {err ? <> · could not read /api/version: <code>{err}</code></> : null}
            </span>
            <button type="button" className="banner-btn" onClick={onDisconnect}>
                Disconnect
            </button>
        </div>
    );
}
