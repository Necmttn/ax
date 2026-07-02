import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initForesight } from "@ax/foresight";
import { router } from "./router.tsx";
import "./styles/session-tokens.css";

// staleTime keeps cached data "fresh" so a tab switch doesn't re-trigger the
// loading state. We re-fetch on focus so live ingest events are picked up
// without manual refresh.
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: true,
            retry: 1,
        },
    },
});

initForesight({ dev: import.meta.env.DEV, devtools: import.meta.env.DEV });

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
        </QueryClientProvider>
    </StrictMode>,
);
