"use client";

export function HookBacktestShowcase() {
  return (
    <section id="hook-backtest" className="showcase-hook-backtest">
      <main className="wrap">
        <p className="eyebrow">before-you-ship · cases</p>
        <h2>
          Ask the graph what your hook <em>would have</em> caught.
        </h2>
        <p className="lede">
          You write a guardrail. You don&apos;t know if it&apos;ll catch real mistakes or
          just become noise. ax hooks cases scores the candidate against labeled
          cases from your own session history - true and false positives, a real
          precision number - so the decision to ship is evidence, not vibes.
        </p>

        <div className="split">
          {/* hook source */}
          <article className="hook-card" aria-label="proposed hook">
            <header className="hook-head">
              <span className="filename">
                ~/.ax/hooks/
                <b style={{ color: "var(--ink)", fontWeight: 500 }}>
                  main-branch-guard.ts
                </b>
              </span>
              <span className="badge">candidate</span>
            </header>
            <pre className="hook-source">
<span className="c-key">import</span>{" { defineHook, Verdict, GitEnv } "}<span className="c-key">from</span>{" "}<span className="c-str">{"\"@ax/hooks-sdk\""}</span>{";\n\n"}
<span className="c-key">export default</span>{" "}<span className="c-fn">defineHook</span>{"({\n  name: "}
<span className="c-str">{"\"main-branch-guard\""}</span>{",\n  events: ["}
<span className="c-str">{"\"PreToolUse\""}</span>{"],\n  matcher: { tools: ["}
<span className="c-str">{"\"Bash\""}</span>{"] },\n  run: (event) =>\n    Effect.gen("}
<span className="c-key">function*</span>{" () {\n      "}
<span className="c-key">const</span>{" cmd = event.tool?.input.command ?? "}
<span className="c-str">{"\"\""}</span>{";\n      "}
<span className="c-key">if</span>{" (!"}
<span className="c-str">{"/^git (push|commit)\\b/"}</span>{".test(cmd)) "}
<span className="c-key">return</span>{" Verdict.allow;\n      "}
<span className="c-key">const</span>{" branch = "}
<span className="c-key">yield*</span>{" (yield* GitEnv).currentBranch(event.cwd);\n      "}
<span className="c-key">if</span>{" ("}
<span className="c-str">{"/^(main|master|production)$/"}</span>{".test(branch ?? "}
<span className="c-str">{"\"\""}</span>{"))\n        "}
<span className="c-key">return</span>{" Verdict."}
<span className="c-fn">block</span>{"("}<span className="c-str">{"\"direct write to protected branch\""}</span>{");\n      "}
<span className="c-key">return</span>{" Verdict.allow;\n    }),\n});"}
            </pre>
            <footer className="hook-foot">
              <span>PreToolUse · Bash</span>
              <span className="gut">16 lines · gut-check before the replay</span>
            </footer>
          </article>

          {/* terminal mock */}
          <section className="term-frame" aria-label="backtest run">
            <header className="term-chrome">
              <span className="term-dot term-dot-r" />
              <span className="term-dot term-dot-y" />
              <span className="term-dot term-dot-g" />
              <span className="term-title">
                ax <span className="seg">·</span> hooks cases{" "}
                <span className="seg">·</span> ~/Projects/ax
              </span>
            </header>
            <pre className="term-body">
<span className="term-line"><span className="t-prompt">~/.claude $</span> <span className="t-cmd">ax hooks cases</span> main-branch-guard <span className="t-flag">--since=</span><span className="t-num">7</span></span>{"\n"}
<span className="term-line"><span className="t-muted">  ↳ replay window  </span> 2026-05-21 → 2026-05-28  <span className="t-muted">(7d)</span></span>{"\n"}
<span className="term-line"><span className="t-muted">  ↳ sessions       </span> <span className="t-num">14</span> claude_code, <span className="t-num">3</span> codex  <span className="t-muted">(17 total)</span></span>{"\n"}
<span className="term-line"><span className="t-muted">  ↳ tool_calls     </span> <span className="t-num">1,247</span> bash invocations indexed</span>{"\n"}
<span className="term-line"> </span>{"\n"}
<span className="term-line"><span className="t-muted">  replaying…</span> <span className="t-ok">████████████████████</span> <span className="t-muted">1247/1247  4.2s</span></span>{"\n"}
<span className="term-line"> </span>{"\n"}
<span className="term-line rule">  ───────────────────────────────────────────────────────────</span>{"\n"}
<span className="term-line">  <span className="t-strong">verdict</span>          <span className="rec-badge">SHIP · HIGH-CONFIDENCE</span></span>{"\n"}
<span className="term-line rule">  ───────────────────────────────────────────────────────────</span>{"\n"}
<span className="term-line"><span className="t-muted">  fires            </span> <span className="t-num">12</span> / 1,247 calls  <span className="t-muted">(0.96%)</span></span>{"\n"}
<span className="term-line"><span className="t-muted">  ├─ </span><span className="t-bad">true positives </span> <span className="t-num">11</span>  <span className="t-muted">would have blocked actual main-branch pushes</span></span>{"\n"}
<span className="term-line"><span className="t-muted">  └─ </span><span className="t-warn">false positives</span> <span className="t-num"> 1</span>  <span className="t-muted">legitimate hotfix → production · 2026-05-24</span></span>{"\n"}
<span className="term-line"> </span>{"\n"}
<span className="term-line"><span className="t-muted">  precision        </span> <span className="t-ok">0.917</span>   <span className="t-muted">recall</span> <span className="t-ok">0.917</span>   <span className="t-muted">F1</span> <span className="t-ok">0.917</span></span>{"\n"}
<span className="term-line"><span className="t-muted">  prevented rollbacks </span> <span className="t-num">5</span>     <span className="t-muted">(traced via post-event reverts)</span></span>{"\n"}
<span className="term-line"> </span>{"\n"}
<span className="term-line"><span className="t-muted">  by repo</span></span>{"\n"}
<span className="term-line"><span className="t-muted">    </span><span className="t-file">~/Projects/ax</span>        <span className="t-num"> 8</span>  <span className="t-bad">▮▮▮▮▮▮▮▮</span></span>{"\n"}
<span className="term-line"><span className="t-muted">    </span><span className="t-file">~/Projects/quera</span>     <span className="t-num"> 3</span>  <span className="t-bad">▮▮▮</span></span>{"\n"}
<span className="term-line"><span className="t-muted">    </span><span className="t-file">~/Projects/dotfiles</span>  <span className="t-num"> 1</span>  <span className="t-warn">▮</span> <span className="t-muted">← false positive lives here</span></span>{"\n"}
<span className="term-line"> </span>{"\n"}
<span className="term-line"><span className="t-muted">  one to review:</span></span>{"\n"}
<span className="term-line"><span className="t-muted">    </span><span className="t-id">sess_8af3·turn-42</span>  <span className="t-warn">hotfix/prod-token-leak</span>  <span className="t-muted">→ allow-list?</span></span>{"\n"}
<span className="term-line"> </span>{"\n"}
<span className="term-line"><span className="t-ok">  install with:</span> <span className="t-cmd">ax hooks install</span> ~/.ax/hooks/main-branch-guard.ts <span className="t-flag">--providers=</span>claude,codex</span>{"\n"}
<span className="term-line"><span className="t-prompt">~/.claude $</span> <span className="term-caret" aria-hidden="true" /></span>
            </pre>
          </section>
        </div>

        {/* week strip */}
        <section className="week" aria-label="7-day session distribution">
          <header className="week-head">
            <span className="label">
              replay window · 17 sessions · 1,247 bash calls
            </span>
            <span className="meta">
              2026-05-21 → 2026-05-28 · <b>12 fires</b> ·{" "}
              <b>5 rollbacks prevented</b>
            </span>
          </header>

          <div className="week-grid">
            <div className="day-label">
              <b>Thu 21</b>3 sessions
            </div>
            <div className="day-row">
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick tp" title="true positive · ~/Projects/ax" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="day-count">163 calls</span>
            </div>

            <div className="day-label">
              <b>Fri 22</b>2 sessions
            </div>
            <div className="day-row">
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick tp" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick saved" title="prevented rollback" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="day-count">131 calls</span>
            </div>

            <div className="day-label">
              <b>Sat 23</b>1 session
            </div>
            <div className="day-row">
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="day-count">86 calls</span>
            </div>

            <div className="day-label">
              <b>Sun 24</b>2 sessions
            </div>
            <div className="day-row">
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span
                className="tick fp"
                title="false positive · hotfix on production"
              />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="day-count">112 calls</span>
            </div>

            <div className="day-label">
              <b>Mon 25</b>3 sessions
            </div>
            <div className="day-row">
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick tp" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick saved" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick tp" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="day-count">221 calls</span>
            </div>

            <div className="day-label">
              <b>Tue 26</b>3 sessions
            </div>
            <div className="day-row">
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick saved" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick tp" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick tp" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="day-count">248 calls</span>
            </div>

            <div className="day-label">
              <b>Wed 27</b>2 sessions
            </div>
            <div className="day-row">
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick saved" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick tp" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="day-count">177 calls</span>
            </div>

            <div className="day-label">
              <b>Thu 28</b>1 session · today
            </div>
            <div className="day-row">
              <span className="tick pass" />
              <span className="tick tp" />
              <span className="tick pass" />
              <span className="tick pass" />
              <span className="tick saved" />
              <span className="tick pass" />
              <span className="tick tp" />
              <span className="tick pass" />
              <span className="tick tp" />
              <span className="tick pass" />
              <span className="day-count">109 calls</span>
            </div>
          </div>

          <div className="legend">
            <span>
              <span className="sw pass" /> pass · normal traffic
            </span>
            <span>
              <span className="sw tp" /> would have blocked · true positive
            </span>
            <span>
              <span className="sw saved" /> traced to a later rollback
            </span>
            <span>
              <span className="sw fp" /> false positive · review
            </span>
          </div>
        </section>

        {/* caption */}
        <aside className="caption">
          <span className="tag">the move</span>
          <p>
            Before you install a guardrail, ax replays your own history against
            it. <b>cases</b> scores a known candidate against labeled outcomes:
            precision, recall, the false positive to review. <b>backtest</b>{" "}
            replays any hook file through your raw tool_call history for a
            would-block rate. Either way a hook ships with a number attached,
            not a hunch.{" "}
            <em>
              No other agent tooling can do this; no one else has the typed
              session graph.
            </em>
          </p>
        </aside>
      </main>
    </section>
  );
}
