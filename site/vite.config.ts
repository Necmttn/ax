import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tanstackStart({ srcDirectory: "app" }), tailwindcss()],
  resolve: { alias: { "~": new URL("./app", import.meta.url).pathname } },
});
