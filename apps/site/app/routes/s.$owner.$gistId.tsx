import { createFileRoute } from "@tanstack/react-router";
import { studioShareUrl } from "~/lib/session-share";

export const Route = createFileRoute("/s/$owner/$gistId")({
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
  const src = studioShareUrl(owner, gistId);

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
