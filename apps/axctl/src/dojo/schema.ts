/**
 * ax dojo - agenda types. Spec: docs/superpowers/specs/2026-06-13-ax-dojo-design.md
 */

export type DojoCostClass = "s" | "m" | "l" | "xl";

export type DojoItemKind =
    | "verdict_pending"
    | "brief_unfilled"
    | "directives"
    | "routing_backtest"
    | "proposal_mint"
    | "experiment"
    | "upstream_draft"
    | "spar"
    | "explore";

export const KIND_PRIORITY: readonly DojoItemKind[] = [
    "verdict_pending",
    "brief_unfilled",
    "directives",
    "routing_backtest",
    "proposal_mint",
    "experiment",
    "upstream_draft",
    "spar",
    "explore",
];

export interface DojoItem {
    readonly id: string;
    readonly kind: DojoItemKind;
    readonly title: string;
    /** exact CLI invocations the executing agent runs for this item */
    readonly commands: readonly string[];
    /** observable completion criterion - what makes this item vanish from the next agenda */
    readonly success: string;
    readonly cost_class: DojoCostClass;
}

export type BindingWindow = "five_hour" | "seven_day";

export interface BudgetEnvelope {
    readonly has_surplus: boolean;
    /** spendable percentage points of the binding window after reserve */
    readonly spendable_pct: number;
    readonly binding_window: BindingWindow | null;
    readonly window_remaining_pct: number;
    readonly reserve_pct: number;
    /** ISO datetime - earliest window reset, or the --until override */
    readonly deadline: string;
    readonly source: "quota" | "override" | "forced" | "unavailable";
}

export interface DojoSourceFailure {
    readonly source: string;
    readonly message: string;
}

export interface DojoAgenda {
    readonly v: 1;
    readonly generated_at: string;
    readonly budget: BudgetEnvelope;
    readonly source_failures: readonly DojoSourceFailure[];
    readonly items: readonly DojoItem[];
}

export const compareByPriority = (
    a: Pick<DojoItem, "kind">,
    b: Pick<DojoItem, "kind">,
): number => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind);
