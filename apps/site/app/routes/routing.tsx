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
          "Your coding agent runs every sub-task it spawns on your most expensive model unless something tells it otherwise. ax measures the leak, warns as it happens, finds the routine work you're overpaying for, and verifies the savings from the actual tokens burned - all local.",
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
