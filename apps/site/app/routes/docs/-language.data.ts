/**
 * Curated PUBLIC glossary for /docs/language.
 *
 * Visitor-facing only. The raw docs/language.md (brand-internal vocabulary,
 * forbidden-terms competitor table, language-governance section, schema/edge
 * internals) is intentionally NOT rendered here anymore - the route reads this
 * typed module instead. The .md stays in the content collection (orphaned) so
 * a later cleanup PR can remove it without colliding with parallel edits.
 *
 * Each term: a mono $-eyebrow (the term), a serif definition, and one
 * "in the wild" usage receipt. Always "ax" in visitor copy, never "axctl".
 * Drift fixed vs the old .md: checkpoints are +3/+10/+30 SESSIONS (not days);
 * the retro loop is watcher-driven (no Stop hook); "ax skills weighted"
 * (not "axctl skills taste"); no repo paths.
 */

/** One glossary entry rendered as a definition card. */
export interface GlossaryTerm {
  /** Mono $-eyebrow - the term as written. */
  readonly term: string;
  /** Optional expansion shown beside the term (e.g. "Agent Experience"). */
  readonly expansion?: string;
  /** Serif definition, 1-3 sentences. */
  readonly definition: string;
  /** One "in the wild" usage line - how it reads in real copy. */
  readonly usage: string;
}

/** A grouped run of terms under a mono $-eyebrow + human heading. */
export interface GlossaryGroup {
  /** Mono $-eyebrow, e.g. "$ the category". */
  readonly eyebrow: string;
  /** Short human heading. */
  readonly title: string;
  readonly terms: readonly GlossaryTerm[];
}

export const GLOSSARY_GROUPS: readonly GlossaryGroup[] = [
  {
    eyebrow: "$ the category",
    title: "What ax is",
    terms: [
      {
        term: "AX",
        expansion: "Agent Experience",
        definition:
          "The discipline of measuring, shaping, and improving what an AI coding agent perceives, remembers, and acts on across sessions. The direct analog of Developer Experience (DX) for human engineers.",
        usage: "AX is to AI agents what DX is to humans.",
      },
      {
        term: "AXL",
        expansion: "Agent Experience Layer",
        definition:
          "A software layer that owns the AX surface - ingest, storage, query, and agent-readable interfaces over the evidence of prior agent behavior. ax is the reference implementation.",
        usage:
          "An Agent Experience Layer needs typed evidence, multi-agent ingest, and an agent-readable interface.",
      },
    ],
  },
  {
    eyebrow: "$ the product surface",
    title: "Names you will see",
    terms: [
      {
        term: "ax",
        definition:
          "The project. Lowercase, always. The whole thing - the agent experience layer over your coding-agent history.",
        usage: "ax watches your sessions and proposes small, repo-specific fixes.",
      },
      {
        term: "axctl",
        definition:
          "The CLI binary under the hood. You mostly type ax; axctl is the technical name of the executable.",
        usage: "The ax command you run is the axctl binary on disk.",
      },
      {
        term: "ax studio",
        definition:
          "The live local dashboard. The improve-first view of your graph: what's next, the proposal deck, experiments, cost and routing.",
        usage: "Open ax studio to triage proposals and watch experiments land.",
      },
      {
        term: "retro",
        definition:
          "A structured reflection collected after a session: what was tried, what worked, what failed, and the next experiment to run. It is a bet on the next session, not a recap. ax drains pending retros in the background (watcher-driven) and through the /retro skill - never via a per-turn Stop hook.",
        usage: "Six retros this week propose the same hook - that's a pattern worth shipping.",
      },
    ],
  },
  {
    eyebrow: "$ the improve loop",
    title: "How fixes get made",
    terms: [
      {
        term: "proposal",
        definition:
          "A repeated-mistake pattern ax mines from your history, surfaced as one small candidate fix - a skill, a hook, a piece of guidance, or a routing change. Reviewed one at a time, never auto-applied.",
        usage: "ax found a 26x recurring mistake and turned it into one proposal.",
      },
      {
        term: "experiment",
        definition:
          "What an accepted proposal becomes: the scaffolded artifact plus a checkpoint schedule. ax measures whether it actually helped at +3, +10, and +30 sessions.",
        usage: "Past bets, measured - this experiment is +10 sessions in and holding.",
      },
      {
        term: "verdict",
        definition:
          "The outcome locked at a checkpoint. One of: adopted (doing real work), ignored (created but never invoked), regressed (made things worse), partial (mixed signal), or no_longer_needed (the pattern self-resolved).",
        usage: "I locked the schema-guardrail verdict as adopted.",
      },
      {
        term: "ax-loop",
        definition:
          "The closed self-improvement cycle: retro -> proposal -> experiment -> verdict -> the next session reads what worked. \"Close the loop\" means one full pass from retro to verdict.",
        usage: "Receipts over vibes - the ax-loop only ships fixes it can measure.",
      },
      {
        term: "ax-graph",
        definition:
          "The local typed evidence store behind everything: sessions, turns, tool calls, skills, commits, retros, proposals, experiments, verdicts. The abstraction is \"the ax-graph\"; the database is an implementation detail.",
        usage: "Everything ax shows you is read back from the local ax-graph.",
      },
      {
        term: "impact / projected value",
        definition:
          "The backtested estimate of what a proposal is worth, computed from your own history - e.g. \"$605 redirectable\" or \"26x recurring.\" ax reprices what already happened from real tokens; it never reports fabricated savings.",
        usage: "This proposal's projected value is $605 redirectable spend.",
      },
    ],
  },
  {
    eyebrow: "$ cost & routing",
    title: "Where the money goes",
    terms: [
      {
        term: "dispatch",
        definition:
          "A sub-task your agent spawns - the routine work that runs on whatever model the harness picks. Left alone, dispatches default to your most expensive model.",
        usage: "ax dispatches shows which sub-tasks ran on the expensive default.",
      },
      {
        term: "routing class",
        definition:
          "A named bucket of look-alike dispatches (file search, well-specified implementation, bug fixes) that can safely tier down to a cheaper model. Judgment work - review, design, planning, audits - never routes automatically.",
        usage: "ax routing tune mined a new routing class from work you keep overpaying for.",
      },
      {
        term: "quota",
        definition:
          "Your live Claude plan usage across the 5-hour and 7-day windows. ax surfaces it in the CLI, your statusline, and the menubar so you see the limit before you hit it.",
        usage: "ax quota --statusline puts your plan usage one glance away.",
      },
    ],
  },
  {
    eyebrow: "$ the surface for agents",
    title: "What agents and people read back",
    terms: [
      {
        term: "recall",
        definition:
          "Full-text search across your turns, commits, and skills. Auto-scopes to the current repo when run inside a git tree. The fastest way to ask \"have I solved this before?\"",
        usage: "ax recall \"surreal index drift\" --scope=here pulled the fix from a session last month.",
      },
      {
        term: "hook",
        definition:
          "A typed guard authored once in Effect TypeScript and run on both Claude Code and Codex via the ax hooks SDK. Verdicts are allow / block / warn / inject; a defect fails open. This is how one person's trick becomes a deterministic team-wide rule.",
        usage: "The route-dispatch hook warns the moment a routine sub-task is about to run expensive.",
      },
      {
        term: "ax skills weighted",
        definition:
          "The ranking of your skills by real usage times their role weight - the honest answer to \"which skills actually earn their place?\" Replaces any older \"taste score\" phrasing.",
        usage: "ax skills weighted surfaced three skills I install everywhere but never run.",
      },
      {
        term: "profile",
        definition:
          "A shareable summary of one seat - stats, rig, and taste patterns - published with ax profile publish. The consent prompt shows you the exact JSON before anything leaves your machine.",
        usage: "ax profile publish posted my profile to a gist after I approved the payload.",
      },
      {
        term: "leaders",
        definition:
          "The public community boards compiled from registered profiles - leaderboards and trending skills at /leaders, with each member's page at /u/<login>. Aggregates only; no code, no transcripts.",
        usage: "/leaders shows trending skills across everyone who opted in.",
      },
    ],
  },
];
