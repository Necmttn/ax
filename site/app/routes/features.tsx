import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { FeaturesPage } from "~/components/features/features-page";

export const Route = createFileRoute("/features")({
  head: () => ({
    meta: [
      { title: "ax · features - what's under the hood" },
      {
        name: "description",
        content:
          "A tour of the data ax keeps on your laptop - the transcripts it indexes, the graph it builds, the stages it derives, the interventions it proposes, and the hooks it watches in real time.",
      },
    ],
  }),
  component: Features,
});

function Features() {
  return (
    <>
      <SiteHeader />
      <FeaturesPage />
      <SiteFooter />
    </>
  );
}
