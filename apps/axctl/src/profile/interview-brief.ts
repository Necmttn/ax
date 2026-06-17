/**
 * The profile-interview brief - `ax profile interview` writes it to
 * .ax/tasks/. An agent session reads it, interviews the user (draft from the
 * graph, then confirm), and submits the result through
 * `ax profile interview submit`. Sibling of wrapped-generate-brief.ts; the
 * difference is two-way (the agent asks the user) + a JSON file target
 * (not the DB).
 */
export interface ProfileInterviewBriefInput {
    readonly date: string;
    readonly skills: ReadonlyArray<{ readonly name: string; readonly source: string }>;
    readonly hooks: ReadonlyArray<string>;
}

/** How many top skills to surface in the brief for the agent to summarize. */
const BRIEF_SKILL_LIMIT = 10;

export const renderProfileInterviewBrief = ({ date, skills, hooks }: ProfileInterviewBriefInput): string => {
    const topSkills = skills.slice(0, BRIEF_SKILL_LIMIT);
    const skillList = topSkills.length > 0
        ? topSkills.map((s) => `- ${s.name} (${s.source})`).join("\n")
        : "- (no skills recorded in the window - ask the user what they lean on)";
    const hookList = hooks.length > 0 ? hooks.join(", ") : "(none installed)";
    return `## Task: Interview me for my ax profile highlights (${date})

You are capturing the **user-authored** layer of my public ax profile - the
"I'm proud of this" content the graph can't mine. The profile already has all
the mechanical metrics; your job is the human layer, grounded in my real setup.

**Style:** draft-then-confirm. Draft candidates from the data BELOW, show them
to me, ask me to confirm / correct / add. Keep my voice - these are MY words,
not template-speak. Short and concrete beats long and generic.

**My rig (already mined - use it to draft):**

Top skills (draft a one-line "what this does / why someone should learn it"
summary for the ones I actually rely on):
${skillList}

Installed hooks (candidate "secret weapons"): ${hookList}
Also scan my dotfiles / scripts dirs (e.g. ~/.claude, ~/.ax, ~/dotfiles) for
setup I'd be proud of - the kind of script/hook that changes how I work.

**Capture these four (all optional - skip any I have nothing for):**
1. **setup** - secret-weapon rigs/hooks/scripts: { title, what, why, link? }.
   The "proud to share" layer. Draft from hooks + dotfiles, then ask me.
2. **skills** - per-skill "learn more": { name, source, summary }. Draft from
   the top skills above; confirm the summaries read true.
3. **taste** - one free-form line: how I work, what I optimize for. ASK me;
   don't invent it.
4. **wins** - specific things I shipped recently: { text, evidence? }.
   Corroborate from \`git log\`, \`ax sessions churn --since=30\`, or PR numbers;
   keep my framing of why it mattered.

**Then submit the final JSON (one call, replaces the whole file):**

\`\`\`bash
echo '<json>' | ax profile interview submit
\`\`\`

\`\`\`json
{
  "v": 1,
  "authored_at": "${date}T00:00:00Z",
  "setup": [{ "title": "instructions-loader.sh", "what": "Injects similar past code into context before I work.", "why": "Stops re-deriving last week's solve.", "link": "https://..." }],
  "skills": [{ "name": "tdd", "source": "superpowers", "summary": "Red-green-refactor; tests before code." }],
  "taste": "I optimize for landed-clean commits, not wall-clock.",
  "wins": [{ "text": "Bespoke duel page", "evidence": "PR #527 · 12 sessions" }]
}
\`\`\`

**Rules:**
- Everything is MY words - confirm before writing anything down. Don't fabricate.
- \`link\` is optional and must be http/https; a private repo URL is fine - it
  publishes as part of my profile. The FIRST \`ax profile publish\` shows the
  exact JSON and asks for consent (and authorizes future auto-refresh); after
  that, review what's public anytime with \`ax profile show\` and remove it all
  with \`ax profile unpublish\`. Don't put anything here I wouldn't publish.
- Submit validates against a schema and fails loudly on a bad shape - fix and
  re-run, never hand-edit the file.
- After submit, run \`ax profile publish\` to fold these into my public gist.

_source: ax profile interview ${date}_
`;
};
