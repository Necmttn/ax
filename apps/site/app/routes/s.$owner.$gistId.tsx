import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { studioShareUrl } from "~/lib/session-share";

export const Route = createFileRoute("/s/$owner/$gistId")({
  // `sub` selects a subagent session file, `view` the transcript/timeline tab.
  // Forwarded into the studio iframe so deep links open exactly what was shared.
  validateSearch: (search: Record<string, unknown>) => ({
    sub: typeof search.sub === "string" && search.sub.length > 0 ? search.sub : undefined,
    view: search.view === "timeline" ? ("timeline" as const) : undefined,
  }),
  head: ({ params }) => ({
    meta: [
      { title: `Shared ax session - ${params.owner}/${params.gistId}` },
      { name: "description", content: "A shared ax session rendered from a Gist artifact." },
    ],
  }),
  component: SharedSessionFrame,
});

function SharedSessionFrame() {
  const { owner, gistId } = Route.useParams();
  const search = Route.useSearch();
  // Frozen at mount: the embedded studio mirrors its own navigation back onto
  // THIS page's URL (history.replaceState from the same-origin iframe), and a
  // reactive src would reload the iframe on every mirrored change.
  const [src] = useState(() => studioShareUrl(owner, gistId, { sub: search.sub, view: search.view }));

  return (
    <main className="share-embed-shell">
      <iframe
        className="share-embed-frame"
        src={src}
        title={`Shared ax session ${owner}/${gistId}`}
      />
      <p className="share-embed-fallback">
        <a href={src}>Open this shared session in ax studio</a>
      </p>
    </main>
  );
}
