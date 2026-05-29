import { createFileRoute } from "@tanstack/react-router";
import { ChapterHero } from "~/components/origin-sections/chapter-hero";
import { Chapter1Tab } from "~/components/origin-sections/chapter-1-tab";
import { ChapterExhibitA } from "~/components/origin-sections/chapter-exhibit-a";
import { Chapter2Scope } from "~/components/origin-sections/chapter-2-scope";
import { ChapterExhibitH } from "~/components/origin-sections/chapter-exhibit-h";
import { Chapter3Signal } from "~/components/origin-sections/chapter-3-signal";
import { ChapterExhibitB } from "~/components/origin-sections/chapter-exhibit-b";
import { Chapter4Example, Chapter4ExampleContinued } from "~/components/origin-sections/chapter-4-example";
import { ChapterExhibitC } from "~/components/origin-sections/chapter-exhibit-c";
import { ChapterExhibitD } from "~/components/origin-sections/chapter-exhibit-d";
import { ChapterExhibitG } from "~/components/origin-sections/chapter-exhibit-g";
import { Chapter5Governance } from "~/components/origin-sections/chapter-5-governance";
import { ChapterExhibitF } from "~/components/origin-sections/chapter-exhibit-f";
import { Chapter6Retro, Chapter6RetroContinued } from "~/components/origin-sections/chapter-6-retro";
import { ChapterExhibitE } from "~/components/origin-sections/chapter-exhibit-e";
import { Chapter7CodingFirst } from "~/components/origin-sections/chapter-7-coding-first";
import { Chapter8WhatAxIs } from "~/components/origin-sections/chapter-8-what-ax-is";
import { ChapterCta } from "~/components/origin-sections/chapter-cta";

export const Route = createFileRoute("/origin")({
  head: () => ({
    meta: [
      { title: "Autocomplete was the last good feedback loop - ax" },
      { name: "description", content: "Tab meant yes. Typing through it meant no. A binary signal, on every keystroke, from the one person who knew. Then we traded the loop for autonomy, one generation at a time. ax is the reflection step the stack lost." },
    ],
  }),
  component: Origin,
});

function Origin() {
  return (
    <main className="essay">
      <ChapterHero />
      <Chapter1Tab />
      <ChapterExhibitA />
      <Chapter2Scope />
      <ChapterExhibitH />
      <Chapter3Signal />
      <ChapterExhibitB />
      <Chapter4Example />
      <ChapterExhibitC />
      <Chapter4ExampleContinued />
      <ChapterExhibitD />
      <ChapterExhibitG />
      <Chapter5Governance />
      <ChapterExhibitF />
      <Chapter6Retro />
      <ChapterExhibitE />
      <Chapter6RetroContinued />
      <Chapter7CodingFirst />
      <Chapter8WhatAxIs />
      <ChapterCta />
    </main>
  );
}
