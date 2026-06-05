import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import {
  DashboardPreview,
  LineageFlow,
  OpenSourceSection,
  TeamsCallout,
  FooterCards,
} from "~/components/landing-v2";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <>
      <SiteHeader />
      <main className="landing-v2">
        <DashboardPreview />
        <LineageFlow />
        <OpenSourceSection />
        <TeamsCallout />
        <FooterCards />
      </main>
      <SiteFooter />
    </>
  );
}
