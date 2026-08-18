/** Shared instrument chrome: the `.rdx` dark scope + icon rail + main slot.
 *  Mission Control and Wrapped both render inside it so the rail nav is shared.
 *  The rail collapses (icons only) / expands (icons + page names); the choice
 *  persists in localStorage. Default is collapsed for the live daemon and
 *  expanded in the mock/demo build (so walkthroughs read the page names).
 *
 *  The entries themselves live in `../nav/manifest.ts` (single source shared
 *  with the route-coverage test) - do not hand-edit a nav list here. */
import { useState, type ReactNode } from "react";
import { ForesightLink } from "@ax/foresight";
import { NAV_ENTRIES } from "../nav/manifest.ts";
import "./instrument.css";

export { NAV_ENTRIES as RAIL };

/** A thin divider renders between adjacent entries whose group differs, so
 *  the 13-entry rail reads as three clusters (overview/explore/manage)
 *  instead of one long list - see manifest.ts for why grouped over flat. */
function railWithDividers() {
    const out: Array<{ kind: "entry"; entry: (typeof NAV_ENTRIES)[number] } | { kind: "divider"; key: string }> = [];
    NAV_ENTRIES.forEach((entry, i) => {
        if (i > 0 && NAV_ENTRIES[i - 1].group !== entry.group) {
            out.push({ kind: "divider", key: `div-${entry.group}` });
        }
        out.push({ kind: "entry", entry });
    });
    return out;
}

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
                    {railWithDividers().map((item) =>
                        item.kind === "divider" ? (
                            <div key={item.key} className="v-mc-rail-divider" aria-hidden="true" />
                        ) : (
                            <ForesightLink key={item.entry.to} to={item.entry.to} title={item.entry.label} aria-label={item.entry.label}
                                activeOptions={{ exact: item.entry.exact ?? false }}
                                activeProps={{ className: "on" }}>
                                <span className="v-mc-rail-g" aria-hidden="true">{item.entry.g}</span>
                                <span className="v-mc-rail-label">{item.entry.label}</span>
                            </ForesightLink>
                        )
                    )}
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
