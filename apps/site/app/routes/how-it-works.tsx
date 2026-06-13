import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { ActHero } from "~/components/how-sections/act-hero";
import { ActWatch } from "~/components/how-sections/act-watch";
import { ActGraph } from "~/components/how-sections/act-graph";
import { ActMine } from "~/components/how-sections/act-mine";
import { ActPropose } from "~/components/how-sections/act-propose";
import { ActMeasure } from "~/components/how-sections/act-measure";
import { ActWhy } from "~/components/how-sections/act-why";

export const Route = createFileRoute("/how-it-works")({
  head: () => ({
    meta: [
      { title: "How ax works - ax" },
      {
        name: "description",
        content:
          "Watch, graph, mine, propose, measure. ax reads your coding-agent history from five harnesses into a typed local graph, mines the mistakes you repeat, and hands them back as small fixes you review one at a time.",
      },
    ],
  }),
  component: HowItWorks,
});

function HowItWorks() {
  return (
    <>
      <SiteHeader />
      <main className="how-main">
        <ActHero />
        <ActWatch />
        <ActGraph />
        <ActMine />
        <ActPropose />
        <ActMeasure />
        <ActWhy />
      </main>
      <SiteFooter />
    </>
  );
}
