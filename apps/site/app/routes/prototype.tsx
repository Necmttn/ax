/* THROWAWAY prototype route - /prototype?variant=A|B|C
   Three structurally-different takes on a nullframe-derived ax redesign, with
   a dark/light toggle. Pick a direction, then this whole route gets deleted.
   Source grammar: github.com/m1ckc3s/nullframe (MIT). */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import "../components/prototype/redesign.css";
import { Switcher, type Theme } from "../components/prototype/switcher";
import { VariantMissionControl } from "../components/prototype/variant-mission-control";
import { VariantLanding } from "../components/prototype/variant-landing";
import { VariantArticle } from "../components/prototype/variant-article";

// Mission Control won; the prototype now shows that ONE language across the
// three brand surfaces so we can judge cohesion + the ax uniqueness levers.
const VARIANTS = [
    { key: "app", name: "App · Mission Control" },
    { key: "landing", name: "Landing" },
    { key: "article", name: "Article + figures" },
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
    const variant = search.variant ?? "app";
    const theme: Theme = search.theme === "light" ? "light" : "dark";
    const [, force] = useState(0);

    const setVariant = (v: string) => navigate({ search: (p) => ({ ...p, variant: v }), replace: true }).then(() => force((n) => n + 1));
    const setTheme = (t: Theme) => navigate({ search: (p) => ({ ...p, theme: t }), replace: true }).then(() => force((n) => n + 1));

    return (
        <div className="rdx" data-theme={theme} key={`${variant}-${theme}`}>
            {variant === "app" && <VariantMissionControl theme={theme} />}
            {variant === "landing" && <VariantLanding theme={theme} />}
            {variant === "article" && <VariantArticle theme={theme} />}
            <Switcher variants={VARIANTS} current={variant} onVariant={setVariant} theme={theme} onTheme={setTheme} />
        </div>
    );
}
