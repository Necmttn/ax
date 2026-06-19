/** Shared instrument chrome: the `.rdx` dark scope + icon rail + main slot.
 *  Mission Control and Wrapped both render inside it so the rail nav is shared. */
import type { ReactNode } from "react";
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

export function InstrumentShell({ children }: { children: ReactNode }) {
    return (
        <div className="rdx" data-theme="dark">
            <div className="v-mc">
                <nav className="v-mc-rail">
                    <div className="logo">ax</div>
                    {RAIL.map((r) => (
                        <Link key={r.to} to={r.to} title={r.label} aria-label={r.label}
                            activeOptions={{ exact: (r as { exact?: boolean }).exact ?? false }}
                            activeProps={{ className: "on" }}>
                            {r.g}
                        </Link>
                    ))}
                </nav>
                <main className="v-mc-main">{children}</main>
            </div>
        </div>
    );
}
