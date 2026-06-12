import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { RoutingPage } from "~/components/routing/routing-page";

export const Route = createFileRoute("/routing")({
  head: () => ({
    meta: [
      { title: "ax · routing - route the expensive model where it earns its keep" },
      {
        name: "description",
        content:
          "Any subagent dispatch that doesn't pin a model inherits the expensive one. ax measures the leak, nudges at dispatch time, tunes a routing table from your own dispatch history, and verifies the savings against real token buckets - all local.",
      },
    ],
  }),
  component: Routing,
});

function Routing() {
  return (
    <>
      <SiteHeader />
      <RoutingPage />
      <SiteFooter />
    </>
  );
}
