import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";
import { initForesight } from "@ax/foresight";

if (import.meta.env.DEV) {
  initForesight({
    dev: true,
    devtools: true,
    devtoolsLoader: async () => {
      const { initializeForesightDevtools } = await import("@ax/foresight/devtools");
      initializeForesightDevtools();
    },
  });
} else {
  initForesight();
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
