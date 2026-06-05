import { Link } from "@tanstack/react-router";

export function TeamsCallout() {
  return (
    <section className="teams-callout" aria-labelledby="teams-callout-title">
      <div className="open-source-head">
        <span className="eyebrow">for teams</span>
        <h2 id="teams-callout-title">
          Free for your loop. Evidence for your team.
        </h2>
        <p>
          Everything above runs on your laptop, yours to fork. When you need to
          see how a whole team ships with AI&nbsp;&mdash; what&rsquo;s
          spreading, what&rsquo;s stuck, and what should become standard
          practice&nbsp;&mdash; that&rsquo;s ax for teams.
        </p>
      </div>
      <div className="oss-actions">
        <Link className="oss-action primary" to="/teams">
          See ax for teams
          <span className="oss-action-arrow" aria-hidden="true">
            &rarr;
          </span>
        </Link>
      </div>
    </section>
  );
}
