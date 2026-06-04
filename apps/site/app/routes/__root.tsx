import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import "../styles/globals.css";

export const Route = createRootRoute({
  head: () => {
    const title = "ax - the agent experience layer";
    const description =
      "ax watches every session your coding agent runs, spots the mistakes it repeats, and turns them into small, repo-specific fixes you review and apply - one at a time. Local-first, typed, AGPL-3.0.";
    const url = "https://ax.necmttn.com";
    const image = `${url}/og.png`;
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title },
        { name: "description", content: description },
        // Open Graph
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "ax" },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: url },
        { property: "og:image", content: image },
        { property: "og:image:width", content: "1280" },
        { property: "og:image:height", content: "640" },
        // Twitter
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
        { name: "twitter:image", content: image },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  component: () => (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
