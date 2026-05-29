# Pull-based session retros via a `reviewed` graph edge

The first design for session retros was push-based: a Claude Code
`SubagentStop` hook would fire `ax retro emit` after every turn,
inserting a retro row keyed by session. That has two problems.

First, Stop hooks run on the agent's hot path. Even a fast hook
introduces visible turn latency, and any failure inside it blocks the
agent from returning to the user. Second, the hook can only emit a
deterministic heuristic retro (counts of turns, top failing tool, etc.)
because it cannot pause to think; the retros are cheap but shallow.

We adopt a pull-based variant instead. `ax retro emit` still exists for
the deterministic path, but the primary surface is now `ax retro
pending` + `ax retro brief` + a `retro-reviewer` subagent dispatched by
the `/retro` skill. A session is "pending retro" iff it has no
outbound `reviewed` graph edge AND is finished (either `ended_at` is
set, or its last turn is older than an idle threshold). The skill
drains the backlog on demand, in parallel, with the user's idle Opus
quota - a "quota arbitrage" pattern: weekly windows that would
otherwise expire unused get spent on harness improvement instead.

`reviewed` is a typed RELATION (`session -> retro`) with a UNIQUE(in,
out) index, not a foreign-key column on `retro`. We already have
`retro.session` as a record reference, so the edge is technically
duplicate state. We accept the duplication for three reasons. (1) The
existing convention - `spawned`, `produced`, `invoked`, `corrected_by`
- is that every session-relationship is a RELATION; `reviewed` matches
the rest of the graph. (2) Graph traversals stay symmetric
(`session->reviewed->retro->proposal` reads cleanly in both
directions). (3) The hot query for `ax retro pending` is `WHERE
count(->reviewed) = 0`, which is cheaper and clearer than a `NOT IN
(SELECT session FROM retro)` subquery and parallels how we ask "no
spawned children" or "no produced commits" elsewhere.

The pending query is two-pass and deliberately avoids the per-session
`count(turn)` subquery that blew up the v0 prototype (48s for a LIMIT
5). Pass one selects sessions with `ended_at` in the window; pass two
selects sessions without `ended_at` whose `started_at` is older than
the idle threshold (proxy for "user closed the tab"). Subagent
sessions (`source = 'claude-subagent'`) are excluded by default because
their retros belong to the parent session's review. Turn count and
last-turn timestamp are fetched lazily inside `ax retro brief`, not
here.

Trade-off: the subagent-driven path is per-session more expensive than
a single Stop hook firing, so we'd lose on cost if we ran it on every
session unconditionally. That's the point of pulling. The user (or a
weekly cron) chooses when to spend the quota; sessions accumulate in
the pending queue until then. The deterministic `ax retro emit`
heuristic remains as a fallback for Stop-hook users who want the cheap
signal regardless.
