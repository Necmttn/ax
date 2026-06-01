export function ChapterExhibitB() {
  return (
    <figure className="fig-ledger" aria-label="Four signal sources already on your laptop, joined in the ax graph">
      <div className="fig-head">
        <span className="fig-id">Exhibit B</span>
        <span>signal sources · joined evidence, not vibes</span>
      </div>

      <div className="ledger-grid">
        <div className="ledger-col">
          <div className="col-head"><span className="col-num">01</span>agent retros</div>
          <div className="log-line"><span className="lk">retro</span> 05-24</div>
          <div className="log-line">failed=<span className="lv-err">"ran on main"</span></div>
          <div className="log-line">next=use-hook</div>
        </div>

        <div className="ledger-col">
          <div className="col-head"><span className="col-num">02</span>human corrections</div>
          <div className="log-line"><span className="lk">sess#</span>4129</div>
          <div className="log-line"><span className="lv-err">"you're on main again"</span></div>
          <div className="log-line"><span className="lk">→</span> moved to worktree</div>
        </div>

        <div className="ledger-col">
          <div className="col-head"><span className="col-num">03</span>tool calls</div>
          <div className="log-line"><span className="lk">Bash{"{"}</span><span className="lv-ref">git checkout main</span><span className="lk">{"}"}</span></div>
          <div className="log-line"><span className="lk">→</span> <span className="lv-err">blocked</span> · pre-tool hook</div>
          <div className="log-line"><span className="lk">Task{"{"}</span><span className="lv-ref">worktree-first</span><span className="lk">{"}"}</span></div>
        </div>

        <div className="ledger-col">
          <div className="col-head"><span className="col-num">04</span>git outcomes</div>
          <div className="log-line"><span className="lk">merged</span> 05-22</div>
          <div className="log-line">no follow-up 14d</div>
          <div className="log-line"><span className="lk">→</span> <span className="lv-ok">verdict=kept</span></div>
        </div>
      </div>

      <div className="join-row">
        <span className="join-label">ax graph · join</span>
        <span className="join-schema">session<span className="sep">·</span>turn<span className="sep">·</span>tool_call<span className="sep">·</span>skill<span className="sep">·</span>file<span className="sep">·</span>correction<span className="sep">·</span>git_event</span>
      </div>

      <div className="out-row" aria-label="outputs">
        <span className="pill is-live">proposals</span>
        <span className="pill is-live">experiments</span>
        <span className="pill is-live">verdicts</span>
      </div>

      <figcaption>
        <strong>Joined evidence, not vibes.</strong>{" "}
        None of this is exotic. Transcripts, corrections, tool calls,
        commits - all already on your laptop. The missing piece is the
        join.
      </figcaption>
    </figure>
  );
}
