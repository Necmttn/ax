# 67% of my subagent dispatches ran on a frontier model nobody asked for. ax found $605/month of it sitting in my own transcripts. Here's the loop.

Last month my AI coding agents spent $25,027. One machine, 30 days.

$3,956.59 of that was subagents - the Task dispatches my main agent fires off to review specs, fix bugs, locate files. 1,368 dispatches. 67.0% of them ran `inherit`: no model specified, so they inherited the main model. Fable. Opus. For work like "find every caller of this function."

I didn't choose that. Nobody chooses that. It's the default.

## What a single dispatch costs, measured both ways

Take one dispatch from my history: "Implement Task 3: session map strip." Bounded scope, written spec, verifiable output. It ran `inherit`, landed on fable, and cost $50.26. ax re-prices the same dispatch - same token counts, sonnet rates - at $15.08.

```
"Implement Task 3: session map strip"
  ran:        inherit → claude-fable-5    $50.26
  ax-priced:  sonnet                      $15.08   (est. savings $35.18)
```

Two days later a same-shape dispatch, "Implement S2-T3: actor attribution," went out with `model: sonnet` specified. It ran on sonnet and cost $5.23. Same kind of work, same codebase. The only variable that changed was whether anyone named a model.

That gap, multiplied across hundreds of dispatches a month, is the bill.

## The leak you can't see: your routing is lying to you

Here's the part I found after I'd already drafted this article, and it's worse than everything above.

Routing the dispatch is not the same as the dispatch running on the routed model.

In Claude Code, the `model` override applies to the first leg only. The dispatch starts on the cheap model you named. Then a SendMessage follow-up or a post-compaction resume continues the same task - and silently drops back to the parent's frontier model. The dispatch model column still says `sonnet`. The bill says `fable`.

One dispatch made it obvious. "Implement S2-T4" routed to sonnet. The sonnet leg cost about $1. Then it continued, flipped to fable, and ran up $116 of its $117 total. 99% of the cost landed after the override I'd set was already gone.

```
"Implement S2-T4"
  requested:    sonnet
  sonnet leg:   ~$1
  continued on: claude-fable-5   $116
  total:        $117    (99% billed off-model, after the route)
```

Across the same 30 days: 66 routed dispatches continued on a different model than requested. $571.52 of spend on those dropped legs. On this one machine.

Read those two numbers next to each other. The shipped routing classes flag $605/month of addressable savings; tune mines another $599 the defaults never saw. The model-drop leak is $571.52 - and it's the spend on dispatches you already routed correctly. The leak you can't see by reading the dispatch model column is the same size as the one you can.

`ax dispatches` now flags these rows with a `!` marker and a dropped-cost footer, so a route that didn't stick stops looking like a route that worked.

```
$ ax dispatches --days=30

ts                   description            dispatch_model  child_model        cost
2026-06-XXT..:..:..  Implement S2-T4    !   sonnet          claude-fable-5     $117.00
...

dropped (off-model continuation): 66 dispatches  $571.52
```

The takeaway is the whole point of measuring this at the transcript level: routing isn't just choosing the cheap model. It's whether the choice sticks. The dispatch model column can say "sonnet" while the bill says "fable." ax measures that gap. Nothing else does.

## Why everyone defaults to inherit

Three reasons, none of them stupid:

Specifying a model per dispatch is friction. The `model` field is optional, the default works, and the main agent is busy thinking about the task, not the invoice.

Nobody measures it. Your harness shows you a total. It does not show you which subagent ran which model on which description, or what the same dispatch would have cost one tier down.

And the failure mode is invisible. An overpriced dispatch still succeeds. There's no error, no warning, no diff. Just a number at the end of the month that feels too big to argue with.

## The problem nobody measures

On my machine: 67% of 1,368 dispatches inherited fable or opus. The model split among subagents over those 30 days:

```
claude-fable-5      247 dispatches    $1,979.34
claude-opus-4-7     229 dispatches    $  758.83
claude-opus-4-8     225 dispatches    $  747.93
claude-sonnet-4-6   517 dispatches    $  478.36
claude-haiku        114 dispatches    $   47.32
```

Read that twice. Sonnet did 517 review-and-implement dispatches for $478. Fable did 247 for $1,979 - 4x the spend for half the dispatches, on the same shapes of bounded work.

`ax dispatches --candidates` flags $605.02 of that month as addressable: inherit dispatches that match a routine routing class and would have run fine one tier down. That's $7,260 a year. One machine. Found in my own transcripts, sitting on my own disk.

So I built the loop that finds it and closes it. ax is free, open source, and local - it reads your transcripts, never your code, never your API keys. github.com/Necmttn/ax

Here are the 15 rules.

---

## MEASURE: know your number before you touch anything

### Rule 1: Ingest your own transcripts first

ax reads the session files your agents already write to disk - Claude Code, Codex, Pi, OpenCode, Cursor - into a local SurrealDB graph. Nothing leaves your machine.

```
curl -fsSL https://raw.githubusercontent.com/Necmttn/ax/main/install.sh | sh
ax ingest --since=30
```

### Rule 2: Split your spend by origin and model

This is the matrix your harness never shows you: who spent the money - main agent or subagents - and on which model.

```
$ ax cost split --days=30

origin × model, 30 days

subagent  claude-fable-5      247   $1,979.34
subagent  claude-opus-4-7     229   $  758.83
subagent  claude-opus-4-8     225   $  747.93
subagent  claude-sonnet-4-6   517   $  478.36
subagent  claude-haiku        114   $   47.32

total (main + subagent): $25,027
```

### Rule 3: List every dispatch with its price tag

Every Task dispatch, its description, whether a model was specified, and what the child actually cost. Sorted by cost. The expensive rows tell you everything.

```
$ ax dispatches --days=30

ts                   description                        dispatch_model  child_model        cost
2026-06-11T08:52:56  Issue 248 manifest hidden flag     inherit         claude-fable-5     $22.72
2026-06-12T15:25:16  Implement S2-T3: actor attribution sonnet          claude-sonnet-4-6  $ 5.23
...

1368 dispatches  67.0% inherit  total subagent cost: $3956.59  (30 days)
```

### Rule 4: Read the inherit percentage. That's the leak.

`inherit` means no one chose a model - the dispatch silently took the main model. Some of those should be frontier. Most are "implement this spec" and "fix this test." Mine was 67%. An earlier 14-day window on the same machine was 80.7% (574 dispatches, $2,116 subagent spend). The number doesn't fix itself.

```
67.0% of 1,368 dispatches: inherit
→ bounded, well-specified work billed at frontier rates by default
```

### Rule 5: Compute your own annual number

Take the flagged savings, multiply by 12, and decide if it's worth fifteen minutes of setup. Mine:

```
$605.02 flagged / 30 days
× 12 ≈ $7,260 / year
on one machine

top leaking classes:
  well-specified-impl   $282.69
  spec-review           $ 80.66
  bug-fix               $ 69.37
```

---

## TUNE: compile a routing table from your own history

### Rule 6: Start from the shipped defaults

ax ships a default routing table - description prefixes and agent types mapped to the cheapest model that handles them. `ax routing compile` writes it to `~/.ax/hooks/routing-table.json`, merge-preserving, so your own classes survive regeneration.

```
$ ax routing compile

spec-review            ^spec review                            → sonnet
search-locate          ^(pattern-find|locate|find|map|
                         sweep|grep)                           → haiku
research               ^(research|investigate docs|study)      → sonnet
well-specified-impl    ^implement                              → sonnet
bulk-mechanical        ^(write announcements|regenerate|
                         standardize|merge main)               → sonnet
task-N-impl            ^Task \d+:                              → sonnet
bug-fix                ^Fix\s                                  → sonnet
feature-add            ^Add\s                                  → sonnet
agent-type: Explore, codebase-locator,
            codebase-pattern-finder                            → haiku
agent-type: codebase-analyzer                                  → sonnet
```

### Rule 7: Flag the candidates and get a dollar figure

`--candidates` filters your dispatch history to the expensive inherit runs that match a routing class, and prices the alternative per dispatch.

```
$ ax dispatches --candidates --days=30

flagged: inherit + fable/opus + class match
est. savings: $605.02

top classes by savings:
  well-specified-impl   $282.69
  spec-review           $ 80.66
  bug-fix               $ 69.37
```

### Rule 8: Mine new classes from your unmatched spend

Your dispatch descriptions have patterns the defaults don't know. `ax routing tune` clusters the expensive inherit dispatches that no class caught (two-token prefix clustering, clusters of 3+), and proposes new classes suggesting sonnet. Dry-run first. This is the actual output on my history - $599.00 of spend the default table never saw:

```
$ ax routing tune --days=30 --dry-run

id               pattern                suggest  count  addressable  judgment
issue-N          ^issue\s+\d+\b         sonnet      12      $161.42  no
quality-review   ^quality\s+review\b    sonnet      43      $105.90  YES
plan-phase       ^plan\s+phase\b        sonnet       4       $77.64  YES
final-review     ^final\s+review\b      sonnet      16       $75.70  YES
attempt-N        ^attempt\s+\d+\b       sonnet       9       $26.89  no
impl-N           ^impl\s+\d+\b          sonnet      10       $25.18  no
...

20 proposals  addressable spend: $599.00  (30 days)
apply non-judgment: ax routing tune --days=30   brief: ax routing tune --emit-brief
```

That `issue-N` row alone - "Issue 248 manifest hidden flag" and eleven siblings - is $161.42 of inherit spend with a two-token pattern sitting right on top of it.

```
$ ax routing tune --days=30
applied non-judgment proposals → ~/.ax/hooks/routing-table.json  (origin: user)
```

### Rule 9: Never let judgment work auto-route. Backtest it.

This is the rule that keeps the loop honest. Look at the dry-run above: 14 of my 20 mined proposals carry `judgment: YES` - quality-review ($105.90), plan-phase ($77.64), final-review ($75.70). Those are never auto-applied, even though they're the biggest clusters. Of the $599.00 mined, only $218.63 is auto-appliable; $380.35 is judgment-gated. A false-positive routing class on review or plan work costs more than it saves. Gated proposals ship as a task brief; your agent adversarially backtests each class against false positives; only survivors get applied.

```
$ ax routing tune --days=30 --emit-brief
wrote .ax/tasks/routing-tune-2026-06-13.md

# agent backtests each proposed class against history,
# hunting for dispatches that would have routed wrong

$ ax routing tune --apply=<id>,<id> --days=30
```

### Rule 10: Install the hook that makes it real

The routing table does nothing until something reads it. The `route-dispatch` hook fires on every Agent dispatch in Claude Code, reads `routing-table.json` at fire time, and injects the cheaper model on matching dispatches. Deterministic, fails open. The `efficient-dispatch` skill handles the cognitive side: teaching the main agent to specify cheap models explicitly in the first place.

```
ax hooks init
ax hooks install ~/.ax/hooks/route-dispatch.ts --providers=claude
npx skills add Necmttn/ax
```

---

## OPERATE: keep the leak closed

### Rule 11: Treat flagged savings as a health metric. It should trend to zero.

Once the hook is live, `--candidates` measures what's escaping the table. Run it weekly. A rising number means new dispatch patterns the table hasn't learned yet. My current week - heavy implementation sprint, hook freshly installed mid-window - still shows the pre-hook leak:

```
$ ax dispatches --candidates --days=7

total est savings: $419.50
top classes: well-specified-impl ($212.30), spec-review ($65.15), bug-fix ($54.65)

# target as routed dispatches replace inherit ones: → $0
```

### Rule 12: Audit the table, not the vibes

`ax routing show` prints the effective table with origins - which classes are shipped defaults, which ones you mined from your own history. If you don't recognize a `user` class, trace it back to the tune run that created it.

```
$ ax routing show

id                    pattern              suggest   origin
spec-review           ^spec review         sonnet    default
well-specified-impl   ^implement           sonnet    default
bug-fix               ^Fix\s               sonnet    default
...
issue-N               ^issue\s+\d+\b       sonnet    user      ← mined by tune
```

### Rule 13: Write dispatch descriptions that route well

The matcher is prefix patterns on the description. Real rows from my candidates list - dispatches whose names already match a class but ran inherit before the hook:

```
"Implement Task 1: EventJournal core"   matched ^implement      ran fable $12.72   sonnet est. saves $8.91
"Sweep stale 8520 port refs"            matched ^(...|sweep)    ran fable $ 8.56   haiku  est. saves $7.70
"Fix ingest run lifecycle"              matched ^Fix\s          ran fable $30.98   sonnet est. saves $21.69
```

And "Issue 248 manifest hidden flag" matched nothing until tune mined the `issue-N` class from twelve dispatches shaped like it. A dispatch named "Implement the retry logic from the spec" routes. The same work named "look into the retry thing" inherits fable. Description discipline is free money.

### Rule 14: Re-tune monthly. Your dispatch patterns drift.

New projects mean new description shapes. A monthly tune run catches clusters the table missed; judgment-flagged ones go through the brief flow, same as Rule 9.

```
ax routing tune --days=30 --dry-run    # review proposals
ax routing tune --days=30              # apply mechanical ones
ax routing tune --days=30 --emit-brief # gate the judgment ones
```

### Rule 15: Keep judgment work on frontier. On purpose.

Inherit is not always wrong. Architecture decisions, plan reviews, tricky design calls - those should run on the strongest model you have, and the table deliberately never touches them. The goal is not "cheapest model everywhere." It's "frontier where judgment lives, sonnet and haiku where the spec is already written."

From my own 30 days - dispatches that ran inherit on fable and should have:

```
stayed frontier, correctly:
  "Plan phase 2 CLI families"          $28.17
  "Plan phase 4 parser seam"           $25.29
  "Correctness review of arch PRs"     $21.04
```

tune clustered these too (`plan-phase`, $77.64) - and flagged the cluster `judgment: YES` so it never auto-routes.

---

## Where the math lands

30 days, one machine, real transcripts:

- $25,027 total agent spend; $3,956.59 of it subagents
- 1,368 dispatches, 67.0% inherit
- Sonnet: 517 dispatches, $478.36. Fable: 247 dispatches, $1,979.34. Half the dispatches, 4x the money, same shapes of bounded work.
- $605.02/month flagged by the shipped routing classes - $7,260/year
- On top of that, `ax routing tune` mined $599.00 of unmatched spend into 20 new classes: $218.63 auto-applied, $380.35 judgment-gated pending backtest
- And the leak you can't see by reading the dispatch model column: 66 routed dispatches continued off-model, $571.52 billed at frontier rates after the override was set. "Implement S2-T4" routed to sonnet, then ran $116 of its $117 on fable.
- Top leaks: well-specified-impl $282.69, spec-review $80.66, bug-fix $69.37
- Single-dispatch contrast: "Implement Task 3: session map strip" ran $50.26 on fable inherit, ax-priced at $15.08 on sonnet; a same-shape dispatch explicitly routed to sonnet ran $5.23
- Earlier 14-day window, same machine: $2,301 of sub-task spend on fable/opus vs $83 on sonnet

Honest caveats, because the numbers deserve them: the savings are projections from historical token counts, not A/B-tested quality parity. The route-dispatch hook is Claude Code only today - and it's the backstop, not the strategy; the main mechanism is the agent choosing explicit cheap models at dispatch time. And some inherit dispatches genuinely should be frontier. The table leaves those alone.

## What I'm still trying to understand

The boundary cases. "Implement the spec" routes clean. "Review the design" stays frontier. But "refactor this module" sits in the middle - sometimes mechanical, sometimes a judgment call wearing a mechanical name. Right now ax answers with a gate: anything that smells like judgment goes through an agent-backtested brief before it ever routes down. That's a process answer, not a model answer. I don't yet know if the middle can be classified, or only quarantined.

p.s. - there's a structural thing worth noticing here. every hosted router has the same shape: a platform sits between you and the model, routes your tokens, and takes its cut somewhere in the stack. ax can't do that. it's a local CLI reading transcripts off your own disk. it doesn't proxy your tokens, doesn't bill you, doesn't profit when you spend more or less. the routing table it compiles is yours, built from your history, applied by a hook you can read in one file. the incentive to lower your bill is clean because there's no bill on the other side.

Bookmark this for the next time the invoice makes you wince. Share it with whoever pays yours.

github.com/Necmttn/ax
