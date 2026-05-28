import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import contentCollections from "@content-collections/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    contentCollections(),
    tanstackStart({ srcDirectory: "app" }),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
  ],
  resolve: { alias: { "~": new URL("./app", import.meta.url).pathname } },
});
