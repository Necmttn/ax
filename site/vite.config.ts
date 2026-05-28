import { defineConfig } from "vite";
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
    // "ssr" mirrors START_ENVIRONMENT_NAMES.server from
    // @tanstack/start-plugin-core/constants - stable by design.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
  ],
  resolve: { alias: { "~": new URL("./app", import.meta.url).pathname } },
});
