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
  head: ({ params }) => {
    const og = `https://ax.necmttn.com/og/${params.owner}/${params.gistId}`;
    const url = `https://ax.necmttn.com/s/${params.owner}/${params.gistId}`;
    return {
      meta: [
        { title: `Shared ax session - ${params.owner}/${params.gistId}` },
        { name: "description", content: "A recorded AI coding-agent session - every turn, tool call, and dollar." },
        { property: "og:title", content: "Shared ax session" },
        { property: "og:description", content: "A recorded AI coding-agent session - every turn, tool call, and dollar." },
        { property: "og:type", content: "website" },
        { property: "og:url", content: url },
        // Poster rendered from the session's own data by /og/:owner/:gistId.
        { property: "og:image", content: og },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:image", content: og },
      ],
    };
  },
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
