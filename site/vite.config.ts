import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import contentCollections from "@content-collections/vite";

export default defineConfig({
  plugins: [contentCollections(), tanstackStart({ srcDirectory: "app" }), tailwindcss()],
  resolve: { alias: { "~": new URL("./app", import.meta.url).pathname } },
});
