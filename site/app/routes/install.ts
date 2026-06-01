import { createFileRoute, redirect } from "@tanstack/react-router";

// /install → install.sh on GitHub raw. Lets the curl one-liner stay short:
//   curl -fsSL ax.necmttn.com/install | sh
// Resolves to the canonical script at:
//   https://raw.githubusercontent.com/Necmttn/ax/main/install.sh
export const Route = createFileRoute("/install")({
  beforeLoad: () => {
    throw redirect({
      href: "https://raw.githubusercontent.com/Necmttn/ax/main/install.sh",
      statusCode: 302,
    });
  },
});
