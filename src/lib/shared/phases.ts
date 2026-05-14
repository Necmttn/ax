/**
 * Map a skill name to a workflow phase. Pure / isomorphic - server uses it
 * to compress per-session sequences, SPA uses it to render phase badges.
 *
 * Rules are keyword-based and deliberately broad: better to over-classify
 * (a skill into a sensible phase) than to dump everything into "other".
 */
export type Phase = "plan" | "execute" | "review" | "merge" | "other";

export const PHASES: ReadonlyArray<Phase> = ["plan", "execute", "review", "merge", "other"];

export const PHASE_LABEL: Record<Phase, string> = {
    plan: "Plan",
    execute: "Execute",
    review: "Review",
    merge: "Merge",
    other: "Other",
};

export const PHASE_LETTER: Record<Phase, string> = {
    plan: "P",
    execute: "E",
    review: "R",
    merge: "M",
    other: "·",
};

const exact = (...names: string[]) => new Set(names);

const PLAN_NAMES = exact(
    "superpowers:brainstorming",
    "superpowers:writing-plans",
    "superpowers:executing-plans",
    "gsd:plan-phase",
    "gsd:plan-milestone-gaps",
    "gsd:new-milestone",
    "gsd:add-phase",
    "gsd:insert-phase",
    "gsd:research-phase",
    "gsd:discuss-phase",
    "plan-scope-clarification",
    "pre-edit-planning",
    "cross-layer-change-planning",
    "multica-stage-plan",
    "lazyweb:lazyweb-design-brainstorm",
    "to-issues",
    "to-prd",
    "grill-me",
    "grill-with-docs",
);

const REVIEW_NAMES = exact(
    "review",
    "review-all",
    "simplify",
    "codex:review",
    "codex:adversarial-review",
    "codex:rescue",
    "plannotator-review",
    "plannotator-last",
    "plannotator-annotate",
    "plannotator-compound",
    "multica-stage-review",
    "multica-stage-dogfood",
    "caveman:caveman-review",
    "diagnose",
    "react-doctor",
    "improve-codebase-architecture",
    "verification-before-completion",
    "superpowers:requesting-code-review",
    "superpowers:receiving-code-review",
    "superpowers:verification-before-completion",
);

const MERGE_NAMES = exact(
    "ship",
    "multica-stage-merge",
    "superpowers:finishing-a-development-branch",
    "commit",
    "caveman:caveman-commit",
);

const EXECUTE_NAMES = exact(
    "superpowers:subagent-driven-development",
    "superpowers:executing-plans",
    "superpowers:test-driven-development",
    "superpowers:dispatching-parallel-agents",
    "superpowers:using-git-worktrees",
    "multica-stage-execute",
    "gsd:execute-phase",
    "gsd:quick",
    "gsd:resume-work",
    "tdd",
    "prototype",
    "composto",
    "batch-read-upfront",
    "read-once",
    "agent-browser",
    "dev-browser",
    "sim-test",
    "ios-safari-simulator",
    "electron",
    "video-composer",
);

const startsWith = (name: string, prefix: string): boolean => name.startsWith(prefix);

/**
 * Classify a skill into a workflow phase.
 *
 * Order matters: explicit name lists win over substring rules so e.g.
 * `superpowers:executing-plans` lands in "plan" before falling through to
 * the "execute" keyword check.
 */
export function classifyPhase(name: string): Phase {
    if (PLAN_NAMES.has(name)) return "plan";
    if (REVIEW_NAMES.has(name)) return "review";
    if (MERGE_NAMES.has(name)) return "merge";
    if (EXECUTE_NAMES.has(name)) return "execute";

    // Codex agent-runtime primitives are pure execution.
    if (startsWith(name, "codex:exec_command")) return "execute";
    if (startsWith(name, "codex:write_stdin")) return "execute";
    if (startsWith(name, "codex:spawn_agent")) return "execute";
    if (startsWith(name, "codex:wait_agent")) return "execute";
    if (startsWith(name, "codex:close_agent")) return "execute";
    if (startsWith(name, "codex:send_input")) return "execute";
    if (startsWith(name, "codex:update_plan")) return "plan";
    if (startsWith(name, "codex:update_goal")) return "plan";
    if (startsWith(name, "codex:get_goal")) return "plan";
    if (startsWith(name, "codex:view_image")) return "execute";
    if (startsWith(name, "codex:_create_pull_request")) return "merge";
    if (startsWith(name, "codex:_mark_pull_request")) return "merge";
    if (startsWith(name, "codex:_add_review")) return "review";
    if (startsWith(name, "codex:_fetch_prew_to_pr")) return "merge";

    // Codex MCP tools / GitHub helpers are usually execute by default.
    if (startsWith(name, "codex:mcp__")) return "execute";

    // Keyword catch-alls.
    const lower = name.toLowerCase();
    if (/(?:brainstorm|writing-plan|plan-phase|planning|to-prd|to-issues)/.test(lower)) {
        return "plan";
    }
    if (/(?:review|simplify|diagnose|verif|audit|rescue|annotate)/.test(lower)) {
        return "review";
    }
    if (/(?:merge|ship|commit|finish|release)/.test(lower)) {
        return "merge";
    }
    if (/(?:exec|execute|run|edit|write|test|debug|build|deploy|automate)/.test(lower)) {
        return "execute";
    }
    return "other";
}

/**
 * Compress a phase sequence by collapsing consecutive duplicates so a session
 * with skills [P P E E E R] becomes [P E R]. "other" is dropped entirely so
 * the shape reads as the deliberate workflow, not noise.
 */
export function compressPhaseSequence(
    phases: ReadonlyArray<Phase>,
): ReadonlyArray<Phase> {
    const out: Phase[] = [];
    for (const p of phases) {
        if (p === "other") continue;
        if (out[out.length - 1] === p) continue;
        out.push(p);
    }
    return out;
}

/**
 * Render a compressed phase sequence as a short ASCII shape ("P→E→R→M").
 * Used for grouping and for compact display.
 */
export function shapeKey(phases: ReadonlyArray<Phase>): string {
    return phases.map((p) => PHASE_LETTER[p]).join("→");
}
