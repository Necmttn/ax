import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/s/$owner/$gistId")({
    loader: ({ params }) => {
        throw redirect({
            href: `/studio/?shareOwner=${encodeURIComponent(params.owner)}&gistId=${encodeURIComponent(params.gistId)}`,
        });
    },
});
