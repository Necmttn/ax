import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { HookBacktestShowcase } from "~/components/showcases/hook-backtest";
import { RecallShowcase } from "~/components/showcases/recall";
import { TokenEconomyShowcase } from "~/components/showcases/token-economy";
import { VerdictTimelineShowcase } from "~/components/showcases/verdict-timeline";
import { DispatchRoutingShowcase } from "~/components/showcases/dispatch-routing";
import { QuotaShowcase } from "~/components/showcases/quota";
import { ImproveLoopShowcase } from "~/components/showcases/improve-loop";
import { ChurnShowcase } from "~/components/showcases/churn";
import { ProfilesCommunityShowcase } from "~/components/showcases/profiles-community";

export const Route = createFileRoute("/showcases")({
  component: Showcases,
});

function Showcases() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="showcases-intro">
          <p className="eyebrow">what ax actually does</p>
          <h1>
            Every scenario, <em>one graph</em>.
          </h1>
          <p className="lede">
            Concrete demos of what your local ax instance already exposes. Each
            one is something you can run today, on your own history.
          </p>
          <p className="lede">
            Backtest a hook against history. Search every session you&apos;ve
            ever had. See where your tokens go. Watch a verdict earn its place
            at +30 sessions. Route the intern work to cheaper models. Keep your
            plan budget in view. Take proposals mined from your own transcripts.
            Find out which sessions thrash. Publish your receipts and hand the
            graph to an agent.
          </p>
          <nav className="showcases-nav" aria-label="showcase jump links">
            <a href="#hook-backtest">hook backtest</a>
            <a href="#recall">recall</a>
            <a href="#token-economy">token economy</a>
            <a href="#verdict-timeline">verdict timeline</a>
            <a href="#dispatch-routing">dispatch routing</a>
            <a href="#quota">quota</a>
            <a href="#improve-loop">improve loop</a>
            <a href="#churn">churn</a>
            <a href="#profiles-community">profiles + mcp</a>
          </nav>
        </section>

        <HookBacktestShowcase />
        <RecallShowcase />
        <TokenEconomyShowcase />
        <VerdictTimelineShowcase />
        <DispatchRoutingShowcase />
        <QuotaShowcase />
        <ImproveLoopShowcase />
        <ChurnShowcase />
        <ProfilesCommunityShowcase />
      </main>
      <SiteFooter />
    </>
  );
}
