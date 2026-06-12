/**
 * The deep-analysis brief - `ax improve analyze` writes it to
 * `.ax/tasks/`, the dashboard's "Copy analysis brief" button serves it via
 * GET /api/improve/analyze-brief. An agent session works the brief and
 * writes its findings back through `ax improve propose`, which lands them
 * in the improve loop with `origin: "agent"`.
 */

export interface AnalyzeBriefInput {
    /** ISO date stamp for the brief heading (YYYY-MM-DD). */
    readonly date: string;
}

export const renderAnalyzeBrief = ({ date }: AnalyzeBriefInput): string =>
    `## Task: Deep-analysis pass over the ax graph (${date})

You are an analysis agent with access to the \`ax\` CLI. Mine the telemetry
graph for durable improvement opportunities and write each one back as a
proposal. Mechanical signal-mining already exists - your value is depth:
connect evidence across sources, name root causes, propose the smallest
durable fix.

**Mine (read-only):**
- \`ax sessions churn --since=30\` - repair-heavy sessions, failed checks, episodes
- \`ax dispatches --candidates --days=30\` - misrouted expensive dispatches
- \`ax recall <query>\` - cross-source search when you need context on a pattern
- \`ax skills weighted\` / \`ax skills classify --dry-run\` - skill usage vs hygiene
- \`ax improve list\` - what the loop already knows (do NOT duplicate open proposals)
- the ax MCP tools (recall, sessions_around, session_show, ...) if connected

**Write back - one proposal per durable pattern:**

\`\`\`bash
echo '<json>' | ax improve propose
\`\`\`

JSON shape (\`form\` selects the payload):

\`\`\`json
{
  "form": "guidance | skill | hook | subagent | automation",
  "title": "imperative, specific",
  "hypothesis": "what keeps happening + why this fixes it",
  "confidence": "high | medium | low",
  "frequency": 3,
  "evidence": "session ids, sigs, $ amounts - concrete refs",
  "payload": { ... }
}
\`\`\`

Payloads:
- **guidance**: { "file_target": "CLAUDE.md", "section"?, "suggested_text" }
- **skill**: { "trigger_pattern", "suspected_gap", "proposed_behavior", "expected_impact"? }
- **hook**: { "event_name", "target_tool"?, "hook_command", "recovery_path"?, "smoke_test_command"?, "disable_command"?, "failure_mode"? ("fail_open"|"fail_closed") }
- **subagent**: { "bounded_role", "delegation_trigger", "example_task_patterns"? }
- **automation**: { "trigger_signal", "schedule"?, "action", ...same safety fields as hook }

**Keep numbers alive (preferred):** instead of baking counts into the
hypothesis prose (they expire), also pass:

\`\`\`json
{
  "hypothesis": "fallback prose with today's numbers",
  "hypothesis_template": "{{n}} failed Bash calls in the last 30d keep recurring",
  "evidence_query": "SELECT count() AS n FROM tool_call WHERE name = 'Bash' AND status = 'error' AND ts > time::now() - 30d GROUP ALL;"
}
\`\`\`

The dashboard re-runs the query at view time and fills the {{placeholders}} -
your numbers never go stale. evidence_query must be read-only (SELECT/RETURN).

**Rules:**
- Every proposal MUST carry evidence refs (session ids / dedupe sigs / failure counts / $).
- Re-proposing an existing pattern is fine - same title bumps its frequency instead of duplicating.
- Prefer guidance/skill forms unless a deterministic guard is clearly needed (then hook).
- 3-7 strong proposals beat 20 weak ones.

**Verify:** \`ax improve list\` shows your proposals; the dashboard Improve tab
ranks them with an "agent" badge.

_source: ax improve analyze ${date}_
`;
