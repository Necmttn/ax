/**
 * The "give this to your agent" onboarding prompt - ax's parallel to
 * effect.solutions' "Copy Agent Instructions". Single source of truth consumed
 * by the CLI (`ax setup [--agent-prompt]`, install.sh via the binary) and the
 * landing site copy button. Zero runtime deps so the marketing bundle stays
 * free of @ax/lib weight.
 *
 * Drives the agent through ingest -> verify -> reality-check -> label -> a value
 * tour (profile + Agent Wrapped) -> a parallel insight fan-out -> next, with a
 * woven CONTRIBUTE-back loop: on a failure, a fact the user disputes, or a
 * spotted bug, the agent interviews then files a github.com/Necmttn/ax issue
 * (confirm-before-send), optionally backed by a redacted `ax share`. Opens with
 * a PRIVACY preamble so the agent can answer "is this safe to run?".
 */

/** Dashboard port. Mirrors @ax/lib's DEFAULT_DASHBOARD_PORT; a @ax/lib test
 *  asserts the two match so this zero-dep copy can't silently drift. */
export const DASHBOARD_PORT = 1738;

/** Install one-liner + docs. Single-sourced here for the INSTALL step and for
 *  any surface that wants to show the install command, so it can't drift. */
export const AX_INSTALL_CMD = "curl -fsSL ax.necmttn.com/install | sh";
export const AX_DOCS_URL = "https://ax.necmttn.com/docs";

const HEADER =
    "Set up ax for me, end to end. ax is a local agent-experience graph over my Claude Code + Codex history - it runs locally and I review every change.";

const PRIVACY =
    "PRIVACY (read first, so you can answer if I ask whether this is safe to run): ax is fully local. Ingest reads my transcripts, git history, and tool calls into a SurrealDB on 127.0.0.1 - nothing is uploaded, there is no account, no cloud, and no outbound call at ingest. The ONLY thing that can ever leave my machine is `ax profile publish`, which is opt-in and consent-gated: it shares an aggregates-only JSON (counts, day streaks, model split, skill/hook names, taste-pattern summaries) to a public gist I control - NEVER transcript content, code, project names, or file paths. `--no-cost` strips the dollar figures too, and `ax profile unpublish` deletes it. Do NOT run `ax profile publish` as part of this setup. If I ask about privacy or data handling, answer from these facts; it's AGPL-3.0, so you can also read the source to confirm.";

const FOUNDER_NOTE =
    "A note from Neco (ax's founder): ax is early and I'm hungry for feedback - every bug, wrong number, or rough edge you send back makes it sharper for everyone. Please don't hold back; if something's off, help me fix it.";

const CONTRIBUTE_BLOCK =
    "CONTRIBUTE-BACK (do this whenever a trigger below fires; never publish anything without showing it to me first and getting an explicit yes): Triggers - a step fails; a fact you report looks wrong or surprising to me; you spot a clear bug or improvement in ax itself. When one fires: ask me 2-3 sharp questions to pin down what I expected, which command/hook/agent is involved, and how often - enough for a repro. Then draft a GitHub issue for github.com/Necmttn/ax, show me the full draft, and on my yes file it via `gh` (the ax-repo skill). If a session is the evidence, run `ax share --dry-run` first, show me the redacted gist, and only publish with `ax share` on my yes - then link it in the issue.";

const INSTALL_STEP = `INSTALL - run \`${AX_INSTALL_CMD}\` to install the ax CLI. Reference: ${AX_DOCS_URL}`;

const STEPS: ReadonlyArray<string> = [
    `INGEST MY HISTORY - first run \`ax ingest --dry-run\` and tell me, in plain words, how long a full backfill will take. Then start the ingest in the BACKGROUND so we can keep working: run \`ax ingest\` as a background job with AX_PROGRESS=plain, and watch its output for progress and completion. Tell me I can watch it fill live in the dashboard - run \`ax serve\` and open http://127.0.0.1:${DASHBOARD_PORT}. If it fails or lands zero data after finishing, that's a CONTRIBUTE-BACK trigger. When the ingest finishes, summarize what landed: total sessions, turns, and the top skills/tools I actually use.`,
    "VERIFY - run `ax doctor`. If anything isn't ok, diagnose and fix it, then re-run until it is. If the cause is a bug in ax itself (not my environment), that's a CONTRIBUTE-BACK trigger.",
    "REALITY CHECK - show me the headline facts (sessions, turns, top skills + tools), then ask: does this match how I actually work? Heads-up: verification often hides inside PR commands, hooks, and subagents, so if a number reads lower than my gut says, that's a likely miss. If I disagree with any fact, that's a CONTRIBUTE-BACK trigger - my disagreement is the repro.",
    "LABEL what ax can't classify - run `ax skills classify`. It writes one `.ax/tasks/classify-<skill>.md` brief per skill I use but ax can't role-tag. For each brief: read the skill, decide its role(s), and fill the YAML frontmatter at the top (`primary_role:` is required; `secondary`, `confidence`, `rationale` are optional). Run `ax roles` to see labels already in use. Then run `ax skills lint` to apply them. If it says \"no unclassified skills\", that's fine. Then show `ax skills weighted` and `ax skills config`; tell me which skills you labeled and why, and flag anything ax marked orphan or out-of-scope.",
    `BUILD MY PROFILE + AGENT WRAPPED - first run \`ax profile show\` for a quick text fingerprint (sessions, active days + streak, model split, top skills, installed hooks, workflow arcs, taste patterns) and read it back to me in a few sentences. THEN build my Agent Wrapped deck, because the dashboard's Wrapped tab stays BLANK until you do - ingest does not fill it. Run \`ax wrapped generate\`; it writes a brief to \`.ax/tasks/wrapped-generate-<date>.md\`. Follow that brief: mine my graph for the answers and assemble the recap cards as \`{ "cards": [{question, headline, body, sensitivity?}] }\` JSON, then publish them with \`ax wrapped publish --file=<your-cards.json>\` (or pipe the JSON on stdin). Now my Wrapped deck is populated - tell me to run \`ax serve\` and open http://127.0.0.1:${DASHBOARD_PORT} to see it. All of this stays LOCAL: \`ax profile show\` and \`ax wrapped publish\` write only to my own machine and upload nothing. Do NOT run \`ax profile publish\` (that is the one command that leaves my machine).`,
    `GATHER MY INSIGHTS IN PARALLEL - the three areas below are independent and only READ the local graph, so fan them out instead of running them one by one: dispatch one subagent per area, all at once (cap ~3 concurrent - they share one local SurrealDB). Give each subagent your MOST CAPABLE / strongest-reasoning model - do NOT route these down to a cheap model. This is a one-time setup and the commands can error or return surprising output, so I want an agent that can actually diagnose, retry, and interpret what it sees, not just paste noise back. Brief each one clearly: its area, the exact commands to run, and what to return - the raw output plus a tight read of what stands out (the biggest number, anomalies, anything that looks broken). The areas: (a) SPEND - \`ax cost sessions\`, \`ax cost routability\`, \`ax dispatches --candidates\`; (b) FRICTION - \`ax improve recommend\`, \`ax insights friction\`, \`ax insights tools\`; (c) HISTORY (run inside one of my git repos) - \`ax sessions here --days=30\`, \`ax recall "<a topic worth searching>"\`. When all three return, synthesize across them for me: my single biggest cost driver and the largest concrete saving, the top 1-2 fixes worth accepting and why (if I say yes, run \`ax improve accept <id>\` then \`ax improve lint\`), and one genuinely useful thing from my history.`,
    "GIVE ME A NEXT STEP - recommend 1-2 under-used skills you'd reach for based on what you saw, then end with a concrete CTA: the exact command or prompt I should run next, and what outcome it will produce.",
];

/** Compose the prompt: header, privacy, founder note, contribute block, then numbered steps. */
const render = (steps: ReadonlyArray<string>): string =>
    [
        HEADER,
        PRIVACY,
        FOUNDER_NOTE,
        CONTRIBUTE_BLOCK,
        ...steps.map((s, i) => `${i + 1}. ${s}`),
    ].join("\n\n");

/** Post-install body (7 steps): `ax setup`, install.sh. */
export const AGENT_ONBOARDING_PROMPT = render(STEPS);

/** Pre-install variant (8 steps): the landing copy button paste. */
export const AGENT_ONBOARDING_WITH_INSTALL = render([INSTALL_STEP, ...STEPS]);
