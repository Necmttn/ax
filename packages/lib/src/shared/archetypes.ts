/**
 * The canonical ax archetype dictionary - the SINGLE source of truth.
 *
 * Before this, the mechanical classifier (dashboard/wrapped.ts) and the
 * wrapped-publish agent each named archetypes independently, so the dashboard
 * could show "The Context Curator" while a recap card said "The Architect".
 * Everything - the classifier, the agent prompt, the studio hero, the site SEO
 * pages - must resolve through this list so they can never disagree.
 *
 * Each entry carries: identity (id/slug/name), the public tagline, the
 * machine-readable `criteria` (what earns it), a `humor` line, and a `symbol`
 * the studio renders as a unique dot-matrix sigil per archetype.
 */
export interface ArchetypeDef {
    /** stable id (used by the classifier + as the glyph seed) */
    readonly id: string;
    /** url-safe slug for /archetypes/<slug> SEO pages */
    readonly slug: string;
    /** display name, e.g. "The Context Curator" */
    readonly name: string;
    /** one-line public description */
    readonly tagline: string;
    /** what behaviour earns this archetype (the "requirement") */
    readonly criteria: string;
    /** a wink - shown small under the hero */
    readonly humor: string;
    /** a glyph character sampled into the archetype's unique dot-matrix sigil */
    readonly symbol: string;
}

export const ARCHETYPES: readonly ArchetypeDef[] = [
    {
        id: "architect",
        slug: "the-architect",
        name: "The Architect",
        tagline: "You plan first, codify decisions, and build scaffolding that compounds.",
        criteria: "Planning, spec-writing, and decision-doc activity lead before any code lands.",
        humor: "Writes the ADR before the PR. The PR is mostly the ADR.",
        symbol: "△",
    },
    {
        id: "verifier",
        slug: "the-verifier",
        name: "The Verifier",
        tagline: "You test before declaring victory.",
        criteria: "Verification, typecheck, lint, and test calls dominate the graph.",
        humor: "Trusts nothing. Re-runs the green test just to watch it pass again.",
        symbol: "✓",
    },
    {
        id: "debugger",
        slug: "the-debugger",
        name: "The Debugger",
        tagline: "You turn failures into solved patterns.",
        criteria: "Tool-failure and recovery signals are prominent - you live in the stack trace.",
        humor: "Reads stack traces for fun. Bisects on sight.",
        symbol: "◎",
    },
    {
        id: "orchestrator",
        slug: "the-orchestrator",
        name: "The Orchestrator",
        tagline: "You coordinate work across tools and agents.",
        criteria: "Lots of spawned subagents and high tool diversity.",
        humor: "Why do it yourself when three subagents can argue about it first?",
        symbol: "❖",
    },
    {
        id: "skill-collector",
        slug: "the-skill-collector",
        name: "The Skill Collector",
        tagline: "You build by stacking specialized skills.",
        criteria: "Skill-invocation diversity is the strongest signal.",
        humor: "Has a skill for that. And a skill for installing the skill.",
        symbol: "▦",
    },
    {
        id: "context-curator",
        slug: "the-context-curator",
        name: "The Context Curator",
        tagline: "You ground the agent before making it move.",
        criteria: "Context, recall, and file-reading activity run high.",
        humor: "Reads the whole repo so the agent doesn't have to guess. (It still guesses.)",
        symbol: "◫",
    },
    {
        id: "repo-hopper",
        slug: "the-repo-hopper",
        name: "The Repo Hopper",
        tagline: "You spread agent work across many codebases.",
        criteria: "Repository breadth is the strongest signal.",
        humor: "Monogamy is for monorepos.",
        symbol: "»",
    },
    {
        id: "observer",
        slug: "the-observer",
        name: "The Observer",
        tagline: "Your graph is still warming up.",
        criteria: "Not enough activity has been ingested yet to call it.",
        humor: "Lurking. Powerfully.",
        symbol: "◌",
    },
];

const BY_ID = new Map(ARCHETYPES.map((a) => [a.id, a]));
const BY_SLUG = new Map(ARCHETYPES.map((a) => [a.slug, a]));
const BY_NAME = new Map(ARCHETYPES.map((a) => [a.name.toLowerCase(), a]));
export const OBSERVER = ARCHETYPES.find((a) => a.id === "observer")!;

/** Resolve by id, then by name (so an agent-authored card's name still maps),
 *  falling back to The Observer. Never returns undefined. */
export function resolveArchetype(idOrName: string | null | undefined): ArchetypeDef {
    if (!idOrName) return OBSERVER;
    return BY_ID.get(idOrName) ?? BY_NAME.get(idOrName.toLowerCase()) ?? OBSERVER;
}
export const archetypeBySlug = (slug: string): ArchetypeDef | undefined => BY_SLUG.get(slug);
