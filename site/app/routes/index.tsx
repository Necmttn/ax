import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <main className="p-8"><h1 className="text-4xl">{"ax — scaffolded"}</h1></main>,
});
