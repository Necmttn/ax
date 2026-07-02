/** Shared instrument chrome: the `.rdx` dark scope + icon rail + main slot.
 *  Mission Control and Wrapped both render inside it so the rail nav is shared.
 *  The rail collapses (icons only) / expands (icons + page names); the choice
 *  persists in localStorage. Default is collapsed for the live daemon and
 *  expanded in the mock/demo build (so walkthroughs read the page names). */
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import "./instrument.css";

export const RAIL = [
    { g: "◢", to: "/", label: "mission control", exact: true },
    { g: "≣", to: "/sessions", label: "sessions" },
    { g: "◷", to: "/workflow", label: "workflow" },
    { g: "⎈", to: "/improve", label: "improve" },
    { g: "◧", to: "/cost", label: "cost" },
    { g: "◳", to: "/team", label: "team metrics" },
    { g: "✦", to: "/skills", label: "skills" },
    { g: "⚙", to: "/lab", label: "lab" },
] as const;

const NAV_KEY = "ax:studio-nav-expanded";
const STUDIO_MOCK = import.meta.env.VITE_STUDIO_MOCK === "true";

/** localStorage-backed nav preference; falls back to expanded in the mock/demo
 *  build and collapsed for the live daemon (don't change the default there). */
function readNavExpanded(): boolean {
    if (typeof window === "undefined") return STUDIO_MOCK;
    try {
        const v = window.localStorage.getItem(NAV_KEY);
        if (v === "1") return true;
        if (v === "0") return false;
    } catch { /* ignore */ }
    return STUDIO_MOCK;
}

export function InstrumentShell({ children }: { children: ReactNode }) {
    const [expanded, setExpanded] = useState<boolean>(readNavExpanded);
    const toggle = () => {
        setExpanded((prev) => {
            const next = !prev;
            try { window.localStorage.setItem(NAV_KEY, next ? "1" : "0"); } catch { /* ignore */ }
            return next;
        });
    };
    return (
        <div className="rdx" data-theme="dark">
            <div className={`v-mc${expanded ? " nav-expanded" : ""}`}>
                <nav className="v-mc-rail" aria-label="primary">
                    <div className="logo">ax</div>
                    {RAIL.map((r) => (
                        <Link key={r.to} to={r.to} title={r.label} aria-label={r.label}
                            activeOptions={{ exact: (r as { exact?: boolean }).exact ?? false }}
                            activeProps={{ className: "on" }}>
                            <span className="v-mc-rail-g" aria-hidden="true">{r.g}</span>
                            <span className="v-mc-rail-label">{r.label}</span>
                        </Link>
                    ))}
                    <button
                        type="button"
                        className="v-mc-rail-toggle"
                        onClick={toggle}
                        aria-expanded={expanded}
                        aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
                        title={expanded ? "Collapse navigation" : "Expand navigation"}
                    >
                        <span className="v-mc-rail-g" aria-hidden="true">{expanded ? "«" : "»"}</span>
                        <span className="v-mc-rail-label">collapse</span>
                    </button>
                </nav>
                <main className="v-mc-main">{children}</main>
            </div>
        </div>
    );
}
