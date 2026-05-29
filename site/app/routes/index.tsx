import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { HeroSection } from "~/components/landing-sections/hero";
import { WhatSection } from "~/components/landing-sections/what";
import { AgentsSection } from "~/components/landing-sections/agents";
import { HowSection } from "~/components/landing-sections/how";
import { ChangeSection } from "~/components/landing-sections/change";
import { DemoSection } from "~/components/landing-sections/demo";
import { InstallSection } from "~/components/landing-sections/install";
import { WhySection } from "~/components/landing-sections/why";
import { SiteFooter } from "~/components/landing-sections/site-footer";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <>
      <SiteHeader />
      <main>
        <HeroSection />
        <WhatSection />
        <AgentsSection />
        <HowSection />
        <ChangeSection />
        <DemoSection />
        <InstallSection />
        <WhySection />
      </main>
      <SiteFooter />
    </>
  );
}
