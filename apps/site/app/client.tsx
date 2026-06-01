import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";
import { getRouter } from "./router";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient router={getRouter()} />
    </StrictMode>,
  );
});
