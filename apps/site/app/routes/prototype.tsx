/* THROWAWAY prototype route - /prototype?variant=A|B|C
   Three structurally-different takes on a nullframe-derived ax redesign, with
   a dark/light toggle. Pick a direction, then this whole route gets deleted.
   Source grammar: github.com/m1ckc3s/nullframe (MIT). */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import "../components/prototype/redesign.css";
import { Switcher, type Theme } from "../components/prototype/switcher";
import { VariantMissionControl } from "../components/prototype/variant-mission-control";
import { VariantEditorial } from "../components/prototype/variant-editorial";
import { VariantTerminalOS } from "../components/prototype/variant-terminal-os";

const VARIANTS = [
    { key: "A", name: "Mission Control" },
    { key: "B", name: "Editorial Instrument" },
    { key: "C", name: "Terminal OS" },
] as const;

export const Route = createFileRoute("/prototype")({
    validateSearch: (s: Record<string, unknown>): { variant?: string; theme?: string } => ({
        variant: typeof s.variant === "string" ? s.variant : undefined,
        theme: typeof s.theme === "string" ? s.theme : undefined,
    }),
    head: () => ({ meta: [{ title: "ax redesign prototype" }] }),
    component: PrototypePage,
});

function PrototypePage() {
    const search = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    const variant = search.variant ?? "A";
    const theme: Theme = search.theme === "light" ? "light" : "dark";
    const [, force] = useState(0);

    const setVariant = (v: string) => navigate({ search: (p) => ({ ...p, variant: v }), replace: true }).then(() => force((n) => n + 1));
    const setTheme = (t: Theme) => navigate({ search: (p) => ({ ...p, theme: t }), replace: true }).then(() => force((n) => n + 1));

    return (
        <div className="rdx" data-theme={theme} key={`${variant}-${theme}`}>
            {variant === "A" && <VariantMissionControl theme={theme} />}
            {variant === "B" && <VariantEditorial theme={theme} />}
            {variant === "C" && <VariantTerminalOS />}
            <Switcher variants={VARIANTS} current={variant} onVariant={setVariant} theme={theme} onTheme={setTheme} />
        </div>
    );
}
