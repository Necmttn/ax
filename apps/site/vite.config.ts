import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import contentCollections from "@content-collections/vite";

// SPA / prerender mode - TanStack Start crawls every <a href> from the
// entry and writes static HTML for each reachable route to dist/client/.
// Pure static deploy target - no Cloudflare Worker, no SSR per request,
// no Worker bundle size limit. Deploy via `wrangler pages deploy
// dist/client --project-name=ax`.
//
// Why: every current route renders static content (landing, features,
// showcases, origin, manifesto, MDX docs). No per-request data
// fetching. Per-route Worker invocations were paying SSR cost for
// content that's identical for every visitor. See the
// `start-basic-static` TanStack example for the pattern this mirrors.
//
// _redirects + public/install are honored at the Pages edge natively,
// so the install one-liner resolves without a Worker.
export default defineConfig({
  plugins: [
    contentCollections(),
    tanstackStart({
      srcDirectory: "app",
      spa: {
        enabled: true,
        prerender: {
          crawlLinks: true,
        },
      },
      prerender: {
        failOnError: false,
      },
    }),
    // @vitejs/plugin-react MUST come after tanstackStart - the router
    // plugin tanstackStart pulls in must register first. Provides the
    // React Refresh runtime dev mode needs for client hydration.
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": new URL("./app", import.meta.url).pathname } },
});
