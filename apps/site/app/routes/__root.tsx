import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import "../styles/globals.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ax - the agent experience layer" },
    ],
  }),
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
