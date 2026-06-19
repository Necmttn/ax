---
title: "My router said sonnet. The invoice said fable."
date: "2026-06-13"
excerpt: "A hidden bucket in your AI coding bill: the helper agents your coding agent launches quietly default to your most expensive model. How to measure it, route it down - and the bigger leak hiding in the main agent itself."
tags: ["cost", "routing", "agents"]
---

# My router said sonnet. The invoice said fable.

There's a hidden bucket in your AI coding bill, and it's bigger than you think. When your coding agent works, it quietly launches little helper agents to do side jobs - find a function, fix a test, review a spec. Each helper picks a model to run on. By default it picks the same model you're chatting on, which is usually your most expensive one. Nobody chose that. It's just what happens when no one picks something cheaper.

Last month my AI coding agents spent $25,027. $3,956.59 of that was those helpers - 1,368 of them, and 67% ran on the default expensive model for work a cheaper one would have nailed. "Find every caller of this function" does not need your top-tier model. It got it anyway, 1,368 times.

<FrameworkList label="Quick glossary - this piece uses these a lot">
  <FrameworkItem name="dispatch">a helper task your main agent launches to do one side job</FrameworkItem>
  <FrameworkItem name="inherit">the helper runs on the same model as your main chat (the pricey default)</FrameworkItem>
  <FrameworkItem name="frontier">the top-tier, most expensive model (right now that's the likes of opus or fable)</FrameworkItem>
  <FrameworkItem name="routing">sending routine helper work to a cheaper model on purpose</FrameworkItem>
</FrameworkList>

The expensive default here happened to be `claude-fable-5` - a model so good and so short-lived that people still talk about it like a band that broke up too soon. That's the trap, though: the name on the invoice keeps changing. Fable this month, opus the next, whatever frontier tier your helpers inherit after that. You can't build a cost strategy on which model is cheap today.

<PullQuote cite="the leak isn't a model">
The leak isn't a model. It's that your helpers inherit the expensive one by default - and that outlives every model that comes and goes.
</PullQuote>

One helper task makes the gap concrete. "Implement Task 3: session map strip" - bounded scope, written spec - ran inherit, landed on fable, and cost $50.26; ax re-prices the same work at sonnet rates as $15.08. Two days later a near-identical task ran with sonnet named on purpose and cost $5.23. The only thing that changed was whether anyone picked the model.

<StatGrid label="One helper task, three prices - 'Implement Task 3: session map strip'">
  <Stat value="$50.26" label="inherit → ran on fable" sub="what it actually cost" />
  <Stat value="$15.08" label="ax-priced at sonnet" sub="same work, repriced" />
  <Stat value="$5.23" label="sonnet named on purpose" sub="two days later, same shape" />
</StatGrid>

Multiply that gap across hundreds of helper tasks a month, and that's the bill.

## Why everyone defaults to inherit

Three reasons, none of them stupid. Naming a model per dispatch is friction - the field is optional, the default works, the main agent is thinking about the task, not the invoice. The failure mode is invisible - an overpriced dispatch still succeeds; no error, no warning, no diff, just a number at month-end too big to argue with. And nothing measures it: your harness shows a total, not which subagent ran which model on which description, or what the same dispatch would have cost one tier down.

## The problem nobody measures

Split those 30 days by model (Rule 2) and the shape jumps out: sonnet did 517 review-and-implement dispatches for $478.36; fable did 247 for $1,979.34 - 4x the spend for half the dispatches, on the same shapes of bounded work. Fable's gone now; read its row as whatever frontier model your inherit dispatches land on this month. The waste outlives the price list.

`ax dispatches --candidates` flags $605.02 of that month as addressable: inherit dispatches that match a routine routing class and would have run fine one tier down. $7,260 a year, on my own disk.

## The leak you can't see: your routing is lying to you

Routing the dispatch is not the same as the dispatch running on the routed model.

In Claude Code, the `model` override applies to the first leg only. The dispatch starts on the cheap model you named. Then a SendMessage follow-up or a post-compaction resume continues the same task and silently drops back to the parent's frontier model. The dispatch model column still says `sonnet`. The bill says `fable`.

One dispatch made it obvious. "Implement S2-T4" routed to sonnet. The sonnet leg cost about $1. Then it continued, flipped to fable, and ran up $116 of its $117 total - 99% of the cost landed after the override I'd set was already gone.

<Figure id="Receipt" label="'Implement S2-T4' · the route that didn't stick" lead="The override applied to the first leg only." caption="99% of the cost landed after the routed leg, on the parent's frontier model - and the dispatch_model column still reads sonnet.">

<AxResult>{`"Implement S2-T4"
  requested:    sonnet
  sonnet leg:   ~$1
  continued on: claude-fable-5   $116
  total:        $117    (99% billed off-model, after the route)`}</AxResult>

</Figure>

Across the same 30 days: 66 routed dispatches continued on a different model than requested, $571.52 of spend on those dropped legs. The leak you can't see is the same size as the one you can. `ax dispatches` flags these rows with a `!` marker and a dropped-cost footer, so a route that didn't stick stops looking like a route that worked. ax measures that gap. Nothing else does.

<Figure id="ax dispatches" label="--days=30 · dropped-leg footer" lead="The leak you can't see, made visible." caption="ax marks dropped-leg rows with a ! and a dropped-cost footer, so a route that didn't stick stops looking like a route that worked.">

<AxResult>{`$ ax dispatches --days=30

ts                   description            dispatch_model  child_model        cost
2026-06-XXT..:..:..  Implement S2-T4    !   sonnet          claude-fable-5     $117.00
...

dropped (off-model continuation): 66 dispatches  $571.52`}</AxResult>

</Figure>

So I built the loop that finds it and closes it. ax is free, open source, and local - it reads your transcripts, never your code, never your API keys. github.com/Necmttn/ax

## The three-minute version

<ActionList eyebrow="Do this now · 3 commands" title="If you only do three things">
  <ActionItem title="Measure whether helpers are a real part of your bill." cmd={`curl -fsSL https://raw.githubusercontent.com/Necmttn/ax/main/install.sh | sh
ax ingest --since=30
ax cost split && ax dispatches`}>
    Install ax, ingest 30 days, read the split. If the helper spend is noise, stop here - you're done.
  </ActionItem>
  <ActionItem title="See which expensive helper runs could've used a cheaper model." cmd="ax dispatches --candidates --days=30">
    Puts a dollar figure on it. Mine was $605/month.
  </ActionItem>
  <ActionItem title="If that number's worth it, install the hook that routes future helpers cheaper." cmd={`ax hooks init
ax hooks install ~/.ax/hooks/route-dispatch.ts --providers=claude
npx skills add Necmttn/ax`}>
    Today that auto-advice runs on Claude Code only - ax still *measures* the leak on Codex, Cursor, OpenCode and Pi, you just steer it by hand there for now.
  </ActionItem>
</ActionList>

That's the whole loop. Everything below is the deep version for people who want to tune it hard - 17 rules across measure, tune, operate, and adapt. Skim the headings; dive where it matters.

---

## MEASURE: know your number before you touch anything

### Rule 1: Ingest your own transcripts first

ax reads the session files your agents already write - Claude Code, Codex, Pi, OpenCode, Cursor - into a local SurrealDB graph. Nothing leaves your machine. Measuring works on all five; the auto-advice hook in Rule 10 is Claude Code only for now, so on the others you read the leak and steer by hand.

```
curl -fsSL https://raw.githubusercontent.com/Necmttn/ax/main/install.sh | sh
ax ingest --since=30
```

### Rule 2: Split your spend by origin and model

The matrix your harness never shows: who spent the money - main agent or subagents - and on which model.

<Figure id="ax cost split" label="--days=30 · origin × model" lead="The split your invoice never breaks out." caption="Main agent is the bill: 84% of the $25,027 total. The subagent green slice - the whole subject of this article - is the 16% sliver, broken out below by model. fable is the hot bar: 4x sonnet's spend on half its sessions.">

<SplitBar total="$25,027.00" totalLabel="total (main + subagent)">
  <SplitSeg label="main agent" amount="$21,015.22" pct="84.0%" tone="ink" />
  <SplitSeg label="subagent" amount="$4,011.78" pct="16.0%" tone="green" />
</SplitBar>

<BarChart label="subagent spend by model · 30 days">
  <Bar name="claude-fable-5" amount="$1,979.34" pct="7.9%" value={1979.34} sub="247 sessions" peak />
  <Bar name="claude-opus-4-7" amount="$758.83" pct="3.0%" value={758.83} sub="229 sessions" />
  <Bar name="claude-opus-4-8" amount="$747.93" pct="3.0%" value={747.93} sub="225 sessions" />
  <Bar name="claude-sonnet-4-6" amount="$478.36" pct="1.9%" value={478.36} sub="517 sessions" />
  <Bar name="claude-haiku" amount="$47.32" pct="0.2%" value={47.32} sub="114 sessions" />
</BarChart>

</Figure>

### Rule 3: List every dispatch with its price tag

Every Task dispatch: its description, whether a model was specified, what the child actually cost. Sorted by cost. The expensive rows tell you everything.

<Figure id="ax dispatches" label="--days=30 · sorted by child cost" lead="Every dispatch, priced and sorted." caption="The expensive inherit rows tell you everything; the footer counts the routed dispatches that continued off-model.">

<AxResult>{`$ ax dispatches --days=30

ts                   description                        dispatch_model  child_model        cost
2026-06-11T08:52:56  Issue 248 manifest hidden flag     inherit         claude-fable-5     $22.72
2026-06-12T15:25:16  Implement S2-T3: actor attribution sonnet          claude-sonnet-4-6  $ 5.23
...

1368 dispatches  67.0% inherit  total subagent cost: $3956.59  (30 days)
model drops: 66 routed dispatches continued on a different model ($571.52 on dropped legs, marked "!")`}</AxResult>

</Figure>

### Rule 4: Read the inherit percentage. That's the leak.

`inherit` means no one chose a model - the dispatch silently took the main model. Some of those should be frontier. Most are "implement this spec" and "fix this test." Mine was 67%; an earlier 14-day window on the same machine was 80.7% (574 dispatches, $2,116 subagent spend). Defaults don't audit themselves.

<Callout tone="good" title="the leak, in one line">

67.0% of 1,368 dispatches ran `inherit` - bounded, well-specified work billed at frontier rates by default, because no one picked a cheaper model.

</Callout>

### Rule 5: Compute your own annual number

Multiply the flagged savings by 12 and decide if it's worth fifteen minutes of setup. Mine was $605.02 over 30 days - about $7,260 a year.

<AxResult>{`$605.02 flagged / 30 days  ×12 ≈ $7,260 / year`}</AxResult>

---

## TUNE: compile a routing table from your own history

### Rule 6: Start from the shipped defaults

ax ships a default routing table - description prefixes and agent types mapped to the cheapest model that handles them. `ax routing compile` writes it to `~/.ax/hooks/routing-table.json`, merge-preserving, so your own classes survive regeneration. `ax routing show` prints what landed.

<Figure id="ax routing show" label="the shipped default table" lead="Description prefixes and agent types, mapped to the cheapest model that handles them." caption="ax routing compile writes the table merge-preserving, so your own classes survive regeneration; show prints what landed, with origins.">

```
$ ax routing compile
routing-table written: ~/.ax/hooks/routing-table.json

$ ax routing show

id                            pattern                                     suggest   origin
spec-review                   ^spec review                                sonnet    default
search-locate                 ^(pattern-find|locate|find|map|sweep|grep)  haiku     default
research                      ^(research|investigate docs|study)          sonnet    default
well-specified-impl           ^implement                                  sonnet    default
bulk-mechanical               ^(write announcements|regenerate|standardize|merge main)  sonnet  default
task-N-impl                   ^Task \d+:                                  sonnet    default
bug-fix                       ^Fix\s                                      sonnet    default
feature-add                   ^Add\s                                      sonnet    default
agent-type:Explore                                                        haiku     default
agent-type:codebase-locator                                               haiku     default
agent-type:codebase-pattern-finder                                        haiku     default
agent-type:codebase-analyzer                                              sonnet    default
```

</Figure>

### Rule 7: Flag the candidates and get a dollar figure

`--candidates` filters your dispatch history to the expensive inherit runs that match a routing class, prices the alternative per dispatch, and shows where the $605.02 actually lives:

<Figure id="ax dispatches --candidates" label="--days=30 · est. savings by class" lead="Where the $605.02 actually lives." caption="inherit dispatches that match a routing class, repriced one tier down, ranked by the class that would save the most.">

<AxResult>{`$ ax dispatches --candidates --days=30

flagged: inherit + fable/opus + class match
est. savings: $605.02

top classes by savings:
  well-specified-impl   $282.69
  spec-review           $ 80.66
  bug-fix               $ 69.37`}</AxResult>

</Figure>

### Rule 8: Mine new classes from your unmatched spend

Your dispatch descriptions have patterns the defaults don't know. `ax routing tune` clusters the expensive inherit dispatches that no class caught (two-token prefix clustering, clusters of 3+) and proposes new classes suggesting sonnet. Dry-run first. On my history that surfaced $599.00 of spend the default table never saw:

<Figure id="ax routing tune --dry-run" label="--days=30 · mined proposals" lead="New classes mined from your own history." caption="Two-token prefix clustering over the expensive inherit dispatches no default class caught; judgment-flagged clusters never auto-apply.">

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

</Figure>

The `issue-N` row alone - "Issue 248 manifest hidden flag" and eleven siblings - is $161.42 of inherit spend with a two-token pattern sitting on top of it.

<AxResult>{`$ ax routing tune --days=30
applied non-judgment proposals → ~/.ax/hooks/routing-table.json  (origin: user)`}</AxResult>

### Rule 9: Never let judgment work auto-route. Backtest it.

This is the rule that keeps the loop honest. In the dry-run above, 14 of my 20 proposals carry `judgment: YES` - quality-review ($105.90), plan-phase ($77.64), final-review ($75.70) - the biggest clusters, and never auto-applied. Of the $599.00 mined, only $218.63 is auto-appliable; $380.35 is judgment-gated. A false-positive routing class on review or plan work costs more than it saves. Gated proposals ship as a task brief, your agent adversarially backtests each class against false positives, and only survivors get applied.

<AxResult>{`$ ax routing tune --days=30 --emit-brief
wrote .ax/tasks/routing-tune-2026-06-13.md

# agent backtests each proposed class against history,
# hunting for dispatches that would have routed wrong

$ ax routing tune --apply=<id>,<id> --days=30`}</AxResult>

### Rule 10: Install the hook that makes it real

The routing table does nothing until something reads it. The `route-dispatch` hook fires on every Agent dispatch in Claude Code, reads `routing-table.json` at fire time, and when a forgotten dispatch matches a route-down class, advises the model to re-dispatch on the cheaper tier.

It advises - it does not enforce. A Claude Code hook can't rewrite or block an `Agent` dispatch: the `updatedInput` and `deny` paths are silently ignored for that tool (CC bugs #39814, #40580). The only channel that reaches the model is context, so the hook injects an advisory and the model acts on it. The real routing lives one layer up, in the cognitive loop: the `efficient-dispatch` skill teaches the main agent to name a cheap model in the first place, and the hook is the backstop that catches what it forgot. Fails open.

```
ax hooks init
ax hooks install ~/.ax/hooks/route-dispatch.ts --providers=claude
npx skills add Necmttn/ax
```

---

## OPERATE: keep the leak closed

### Rule 11: Treat flagged savings as a health metric. It should trend to zero.

Once the hook is live, `--candidates` measures what's escaping the table. Run it weekly; a rising number means new dispatch patterns it hasn't learned yet. My hook installed mid-window, so the current week still shows the pre-hook leak:

<AxResult>{`$ ax dispatches --candidates --days=7

total est savings: $419.50
top classes: well-specified-impl ($212.30), spec-review ($65.15), bug-fix ($54.65)

# target as routed dispatches replace inherit ones: → $0`}</AxResult>

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

"Issue 248 manifest hidden flag" matched nothing until tune mined the `issue-N` class from twelve siblings. "Implement the retry logic from the spec" routes; the same work named "look into the retry thing" inherits fable. Description discipline is free money.

### Rule 14: Re-tune monthly. Your dispatch patterns drift.

New projects mean new description shapes. A monthly tune run catches clusters the table missed; judgment-flagged ones go through the brief flow, same as Rule 9.

```
ax routing tune --days=30 --dry-run    # review proposals
ax routing tune --days=30              # apply mechanical ones
ax routing tune --days=30 --emit-brief # gate the judgment ones
```

### Rule 15: Keep judgment work on frontier. On purpose.

Inherit is not always wrong. Architecture decisions, plan reviews, tricky design calls should run on the strongest model you have, and the table deliberately never touches them. The goal is not "cheapest model everywhere." It's "frontier where judgment lives, sonnet and haiku where the spec is already written." From my 30 days, dispatches that ran inherit on fable and should have:

<AxResult>{`stayed frontier, correctly:
  "Plan phase 2 CLI families"          $28.17
  "Plan phase 4 parser seam"           $25.29
  "Correctness review of arch PRs"     $21.04`}</AxResult>

tune clustered these too (`plan-phase`, $77.64) and flagged the cluster `judgment: YES`, so it never auto-routes.

Judgment protection cuts both ways, but only one way is automatic. The hook never routes review, design, or architecture work down. Hand one of those an explicit *cheap* model and it warns you off: "judgment is the catch-rate gate; prefer the strong model." What it does not do is route judgment *up*. Forcing opus onto a dispatch the table already deemed sonnet-adequate buys identical output and burns rate - a vanity metric. So the rule isn't "smartest model on review." It's: never route judgment down, never let you quietly cheap it out, never spend the strong model just to feel safe.

---

## ADAPT: route to your quota, not just your bill

### Rule 16: Conserve by default. Splurge only when the meter says you've earned it.

Routing down is right while you're conserving rate. It's wrong in exactly one window: when your weekly quota is about to reset with budget unspent. Force sonnet then and you just leave allowance on the table. So the hook reads a spend mode off your live plan quota - the same `ax quota` snapshot at `~/.ax/quota-cache.json`, read sync on the hot path, no network on dispatch.

```
conserve  (default)   route-down advisories ON    7d window tight, or cache stale/unknown
splurge   (earned)    route-down advisories OFF   7d resets soon, real headroom, no window near its cap
```

`conserve` is the safe default; stale cache, missing token, low headroom all fall here. Never splurge on uncertainty. `splurge` has to be earned: the 7d window near reset (under 24h), real headroom (over 25% unused), and neither the 5h nor the 7d window near its ceiling - they draw down the same budget, so either cap kills it. Override anytime with `AX_SPEND_MODE=conserve|splurge`.

Splurge is purely subtractive. It does not force anything up. It stops forcing things down, so your forgotten dispatches run on the strong inherited model while the allowance you'd otherwise waste is there to use.

<AxResult>{`$ ax quota --statusline
5h 30% → 15:00 · 7d 19% · SPLURGE ⚡ → /dojo`}</AxResult>

### Rule 17: When you're in splurge, spend the surplus on purpose.

Splurge means weekly allowance about to reset unused, and unused allowance evaporates. That's the budget to burn on self-improvement, not on opus-for-vanity. When the mode flips, ax nudges you once per session to run `/dojo` - the loop that spends surplus quota on backtests, proposal mining, and churn experiments. The system tells you *when* the surplus exists; you decide *whether* to spend it. Proactive, opt-in, in-harness - not a daemon burning your API in the background.

---

## The bigger leak: the main agent itself

Everything above tunes the subagent bill. But go back to Rule 2: subagents were 16% of the $25,027. The main agent - the model running your actual chat - was the other 84%. Every window I split it the same way, the main agent lands between 78 and 81% of total spend. The 17 rules optimize the tail.

So I built a command to look at the trunk. `ax cost routability` classifies main-agent turns by the tools they actually used. Read-only sweeps (gather → haiku), mechanical edits (mechanical-impl → sonnet), and web research (niche-research → sonnet) are routable - bounded work the frontier model did inline that a cheap subagent could have done instead. Reasoning, coordination, and judgment stay on frontier. Then it reprices the routable turns one tier down.

<Figure id="ax cost routability" label="--days=30 · main-agent turns, repriced" lead="The trunk, not the tail." caption="$1,766/month - several times the entire subagent leak - sitting in the model you talk to all day. The stays-main row is genuine reasoning and coordination, correctly left on frontier.">

<AxResult>{`$ ax cost routability --days=30

main-agent spend: $14,478   routable: $3,240 (22%)   est. savings: $1,766

class            runs   turns   main_cost    tier     repriced    est_savings
mechanical-impl 10442   10499    $2890.34   sonnet    $1407.69     $1482.66
gather           1334    1348     $326.94   haiku       $56.01      $270.93
niche-research     71      95      $22.54   sonnet      $10.20       $12.34
stays main      28750   39481   $11238.33   -                -            -

estimate: edit/read turns assumed mechanically routable (upper-ish bound); claude main only.`}</AxResult>

</Figure>

You don't have to read it off the terminal. The same numbers render in **ax studio** - the local dashboard - as a live `/cost` view: the spend split, the per-model bars, and the dispatch candidates, all off your own graph.

<Figure id="ax studio" label="/cost · live dashboard" lead="The receipts, on a screen." caption="Spend split (main vs subagent), per-model bars, and the addressable dispatch candidates - the same data the CLI prints, rendered live from the local daemon. The same view carries an interactive routing tuner: edit a class regex and watch which past dispatches it catches before you save it.">

<img src="/blog/studio-cost-split.png" alt="ax studio /cost view: main-vs-subagent spend split bar, per-model cost bars, and a table of dispatch candidates with suggested cheaper models and estimated savings" style={{ width: "100%", height: "auto", display: "block", borderRadius: "8px" }} />

</Figure>

$1,766 a month. About $21K a year. Several times the entire subagent leak the rest of this article is about - $605 a month - and it was sitting in the model I talk to all day. mechanical-impl is the bulk: the main agent editing files itself instead of handing the edit to a sonnet subagent. The $11,238 `stays main` row is genuine reasoning, coordination, and dispatching work, correctly left on frontier. The goal was never cheap everywhere. It's: stop doing bounded mechanical work inline on the most expensive model you have.

Same caveats as the rest, louder here because the number is bigger. It's an upper bound - a turn that reasons hard and then makes one mechanical edit reads as routable, because the transcript strips the thinking, so call $1,766 a ceiling, not a quote. It's Claude main-agent only by construction; other harnesses' main spend isn't counted. And it's projected from historical token counts, not A/B-tested for quality parity.

The behavior moved before the command existed. Over 90 days my subagent dispatch rate went from 19/day to 114/day - 6x. Call it subagent-driven development: once you see the trunk you start pushing work off it, sending bounded, well-specified, mechanical jobs out to cheap subagents instead of running them inline. Routing those subagents cheaper - the 17 rules - is step 2. Step 1 is not doing the expensive work in the main thread at all.

<PullQuote cite="step 1, before any routing">
The biggest line on the bill is the model you're talking to.
</PullQuote>

---

## Where the math lands

30 days, one machine, real transcripts. $25,027 total agent spend, $3,956.59 of it subagents across 1,368 dispatches, 67.0% inherit. The waste came in three leaks of comparable size:

<StatGrid label="Three leaks of comparable size · 30 days, one machine">
  <Stat value="$605.02" label="shipped classes catch" sub="$7,260/yr · impl $282.69 · review $80.66 · bug-fix $69.37" />
  <Stat value="$599.00" label="ax routing tune mined → 20 classes" sub="$218.63 auto-applied · $380.35 judgment-gated pending backtest" />
  <Stat value="$571.52" label="invisible off-model" sub="66 routed dispatches that continued off-model after the override" />
</StatGrid>

The earlier 14-day window on the same machine told the same story: $2,301 of sub-task spend on fable/opus against $83 on sonnet.

<Callout tone="note" title="honest caveats, because the numbers deserve them">

The savings are projections from historical token counts, not A/B-tested quality parity. The route-dispatch hook is Claude Code only and advisory by nature - it can't rewrite an Agent dispatch, so it nudges the model rather than enforcing. It's the backstop, not the strategy; the main mechanism is the agent choosing explicit cheap models at dispatch time. And some inherit dispatches genuinely should be frontier - judgment work the table never touches in either direction.

</Callout>

## What I'm still trying to understand

The boundary cases. "Implement the spec" routes clean. "Review the design" stays frontier. But "refactor this module" sits in the middle - sometimes mechanical, sometimes a judgment call wearing a mechanical name. ax answers with a gate: anything that smells like judgment goes through an agent-backtested brief before it ever routes down. That's a process answer, not a model answer. I don't yet know if the middle can be classified, or only quarantined.

So here's the actual ask. Run one command: `ax dispatches --candidates --days=30`. Read the number. If it's meaningful, install the hook (Rule 10) and let it nudge your helper tasks cheaper. If you're on Cursor, OpenCode, Codex, or Pi, ax still measures the hidden spend - the auto-advice is Claude Code only for now, so you steer by hand. And if the number comes back as noise, stop. The honest result is sometimes "you don't have this problem," and that's fine. github.com/Necmttn/ax

p.s. - every hosted router has the same shape: a platform sits between you and the model, routes your tokens, and takes its cut somewhere in the stack. ax can't do that. it's a local CLI reading transcripts off your own disk - it doesn't proxy your tokens, doesn't bill you, doesn't profit when you spend more or less. the routing table it compiles is yours, built from your history, applied by a hook you can read in one file.

the incentive to lower your bill is clean because there's no bill on the other side.
