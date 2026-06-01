export function ChapterExhibitD() {
  return (
    <figure className="fig-stack" aria-label="Three enforcement tiers - guidance, skill, hook - with width encoding how easily each is lost">
      <div className="fig-head">
        <span className="fig-id">Exhibit D</span>
        <span>push the fix down the stack · width = lossiness</span>
      </div>

      <div className="stack-wrap">
        <div className="stack-tiers">

          <div className="tier t-guidance">
            <div>
              <div className="tier-label">tier 01</div>
              <div className="tier-name">guidance</div>
            </div>
            <div className="tier-body">
              <p className="tier-note">Lost under context pressure. Read once, forgotten by turn forty.</p>
              <div className="tier-sample">CLAUDE.md &nbsp;<span style={{color: "var(--ink)"}}>·</span>&nbsp; "never work on main, always use a worktree"</div>
            </div>
          </div>

          <div className="tier t-skill">
            <div>
              <div className="tier-label">tier 02</div>
              <div className="tier-name">skill</div>
            </div>
            <div className="tier-body">
              <p className="tier-note">Followed when the agent remembers to invoke it. Better. Not deterministic.</p>
              <div className="tier-sample">skill: worktree-first &nbsp;·&nbsp; invoked when intent matches "new branch / task"</div>
            </div>
          </div>

          <div className="tier t-hook">
            <div>
              <div className="tier-label">tier 03</div>
              <div className="tier-name">hook</div>
            </div>
            <div className="tier-body">
              <p className="tier-note">Deterministic. Cannot be skipped. The outcome becomes binary - touched main or did not.</p>
              <div className="tier-sample">PreToolUse(Bash) &nbsp;·&nbsp; blocks <code>git checkout main</code> · <code>git commit</code> on main</div>
              <span className="locked">locked</span>
            </div>
          </div>

        </div>

        <div className="stack-rail" aria-hidden="true">
          <span className="rail-label">enforcement strength</span>
        </div>
      </div>

      <figcaption>
        <strong>Repeated ignored guidance is a signal that the layer is wrong, not that the wording is.</strong>{" "}
        Guidance is prose and gets dropped. A skill is procedure and holds
        more often. A hook is deterministic and cannot be skipped. The fix
        moves down the stack until the recurrence stops.
      </figcaption>
    </figure>
  );
}
