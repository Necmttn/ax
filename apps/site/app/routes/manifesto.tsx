import { createFileRoute } from "@tanstack/react-router";
import { DocShell } from "~/components/doc-shell";
import { ManifestoContent } from "./-manifesto.content";

export const Route = createFileRoute("/manifesto")({
  head: () => ({
    meta: [
      { title: "Manifesto - ax" },
      { name: "description", content: "Why ax exists - the agent experience layer." },
    ],
  }),
  // Content is the curated TS module (-manifesto.content.tsx), not the orphaned
  // docs/manifesto.md (left in the content collection for a later cleanup PR).
  component: () => (
    <DocShell eyebrow="position paper">
      <ManifestoContent />
    </DocShell>
  ),
});
