import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import contentCollections from "@content-collections/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    contentCollections(),
    // target:"cloudflare-pages" was not a valid option in v1.168 - CF
    // runtime discovery happens via the cloudflare() plugin's
    // viteEnvironment match below.
    tanstackStart({ srcDirectory: "app" }),
    // @vitejs/plugin-react MUST come after tanstackStart - it pulls in
    // @tanstack/router-plugin first, and plugin-react requires that
    // ordering. Provides the React Refresh runtime dev mode needs for
    // client hydration; without it onClick / useState don't fire and
    // the page renders as static SSR HTML only.
    react(),
    // "ssr" mirrors START_ENVIRONMENT_NAMES.server from
    // @tanstack/start-plugin-core/constants - stable by design.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
  ],
  resolve: { alias: { "~": new URL("./app", import.meta.url).pathname } },
});
