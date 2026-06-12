/**
 * The Wrapped-generation brief - `ax wrapped generate` writes it to
 * `.ax/tasks/`, the dashboard's "Regenerate wrapped" button serves it via
 * GET /api/wrapped/generate-brief. An agent session mines the graph and
 * publishes headline cards through `ax wrapped publish`.
 */

export interface WrappedGenerateBriefInput {
    readonly date: string;
}

export const renderWrappedGenerateBrief = ({ date }: WrappedGenerateBriefInput): string =>
    `## Task: Write my Agent Wrapped cards (${date})

You are writing the recap cards for the ax dashboard landing page. The
style target: Paxel-style share cards - an eyebrow question, a BIG short
headline, and at most two supporting lines. The headline carries the card;
people read headlines, not paragraphs. Personality over template-speak:
"You steer, hard" beats "High redirect frequency detected".

**Mine the numbers first (read-only):**
- \`curl -s http://127.0.0.1:1738/api/wrapped\` (or your daemon port) - the
  mechanical profile: usage, streaks, archetypes, metrics, facts
- \`ax cost models --days=30\` - model mix and spend
- \`ax sessions churn --since=30\` - what kept failing
- \`ax dispatches --days=30\` - delegation habits
- \`ax recall <phrase>\` - hunt a specific memorable moment (the best card
  is often one real quote or one absurd number)

**Then publish ~12 cards (10 minimum, 16 max):**

\`\`\`bash
echo '<json>' | ax wrapped publish
\`\`\`

\`\`\`json
{
  "cards": [
    {
      "question": "Which archetype are you?",
      "headline": "The Architect",
      "body": "You plan first, codify decisions, and build scaffolding that compounds.",
      "sensitivity": "public"
    }
  ]
}
\`\`\`

**Card rules:**
- headline <= 6 words; body <= 2 short sentences; question is the eyebrow.
- GROUND the card visually when you can: attach \`"series": [..]\` - 14-30 REAL
  data points that back the claim (daily sessions on that model, redirects per
  week, commits per hour-of-day) plus a short \`"series_label"\` (e.g.
  "sessions/day on fable"). The dashboard draws it as the card's bar strip -
  real shapes beat decoration. Mine the numbers with the SQL console
  (\`POST /api/query\`) or the CLIs above.
- Every card grounded in a real number or real quote from the data - no inventions.
- Mix: archetype, model loyalty, productivity rhythm, prompt style, a funny
  low-light (failed run, all-caps moment), shipping volume, delegation habits.
- ALWAYS include a value-multiplier card: \`ax cost models --days=30\` gives
  API-priced usage in USD; compare it to what the user actually pays in
  subscriptions (ask or assume Claude Code + Codex tiers). "$400 in,
  $23.9K out - a 60x multiplier" - then make the dollars physical: that's
  N base-model Honda Civics a year, M years of rent, you name it.
- Physical-scale comparisons are welcome on any big number (books stacked
  to Eiffel Towers, paper weighed in blue whales, distance flown by a 747) -
  the dashboard already draws a token-scale board, so aim yours at OTHER
  numbers (cost, tool calls, lines shipped).
- Cards order = array order (most shareable first).
- Mark \`"sensitivity": "sensitive"\` on anything with private paths, client
  names, or embarrassing specifics - those stay off the public preview.
- Publishing REPLACES the whole set - emit the full deck in one call.

**Verify:** the dashboard landing (Wrapped) shows your cards; the public
preview hides the sensitive ones.

_source: ax wrapped generate ${date}_
`;
