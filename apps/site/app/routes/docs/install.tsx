import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { DocShell } from "~/components/doc-shell";

export const Route = createFileRoute("/docs/install")({
  head: () => ({
    meta: [
      { title: "Install ax - the agent experience layer" },
      {
        name: "description",
        content:
          "Get ax running in five steps: one curl for the CLI, the skills, your first ingest watched live at ax serve, ax doctor to verify, then your first ax improve recommend.",
      },
    ],
  }),
  component: InstallPage,
});

type Step = {
  n: string;
  label: string;
  title: string;
  cmd: ReactNode;
  note: ReactNode;
};

const STEPS: Step[] = [
  {
    n: "01",
    label: "the cli",
    title: "Install ax",
    cmd: (
      <>
        <span className="prompt">$ </span>curl -fsSL ax.necmttn.com/install | sh
      </>
    ),
    note: (
      <>
        One script. Drops the <code>ax</code> binary on your PATH and registers
        the background watcher so new sessions get ingested automatically. The
        installer auto-falls back to the newest release that actually ships a
        binary, so a half-published release can't break it. To pin a specific
        version, prefix with <code>AXCTL_VERSION=v0.28.0</code>.
      </>
    ),
  },
  {
    n: "02",
    label: "the skills",
    title: "Add the ax skills",
    cmd: (
      <>
        <span className="prompt">$ </span>npx skills add Necmttn/ax
      </>
    ),
    note: (
      <>
        Installs the retro and workflow-extraction skills your agent triggers
        on - so the loop runs inside Claude Code, Codex, and the rest.
      </>
    ),
  },
  {
    n: "03",
    label: "first ingest",
    title: "Ingest your history",
    cmd: (
      <>
        <span className="prompt">$ </span>ax ingest
      </>
    ),
    note: (
      <>
        Reads your coding-agent transcripts into the local graph. Watch it live
        at <code>ax serve</code> →{" "}
        <a href="http://127.0.0.1:1738" target="_blank" rel="noopener noreferrer">
          http://127.0.0.1:1738
        </a>
        . Nothing leaves your machine.
      </>
    ),
  },
  {
    n: "04",
    label: "verify",
    title: "Check the install",
    cmd: (
      <>
        <span className="prompt">$ </span>ax doctor
      </>
    ),
    note: (
      <>
        Confirms the CLI, the watcher, the skills, and the database are all
        wired up. Green across the board means you're ready.
      </>
    ),
  },
  {
    n: "05",
    label: "first fix",
    title: "See your first recommendation",
    cmd: (
      <>
        <span className="prompt">$ </span>ax improve recommend
      </>
    ),
    note: (
      <>
        ax surfaces the repeated mistakes it found and proposes small,
        repo-specific fixes - reviewed one at a time. Receipts over vibes.
      </>
    ),
  },
];

function InstallPage() {
  return (
    <DocShell
      eyebrow="get started"
      title="Install ax"
      lede="Five steps from zero to your first mined fix. ax is local - your transcripts and graph never leave your machine."
    >
      <ol className="install-steps">
        {STEPS.map((step) => (
          <li className="install-step" key={step.n}>
            <div className="install-step-head">
              <span className="install-step-num">{step.n}</span>
              <span className="install-step-label">{step.label}</span>
              <span className="install-step-title">{step.title}</span>
            </div>
            <pre className="install">
              <code>{step.cmd}</code>
            </pre>
            <p className="install-step-note">{step.note}</p>
          </li>
        ))}
      </ol>

      <hr />

      <h2>What you just did</h2>
      <p>
        ax now watches your coding-agent sessions across every harness you run -
        Claude Code, Codex, Pi, OpenCode, and Cursor - mines the mistakes that
        repeat, and turns them into proposals you accept or reject one at a time.
      </p>
      <p>
        Next stops: the{" "}
        <Link to="/routing">cost-routing loop</Link> (route mechanical work to
        cheaper models and measure the savings), the{" "}
        <Link to="/docs/cli-reference">CLI reference</Link> for every command,
        and the <Link to="/docs/language">language</Link> behind the graph.
      </p>
    </DocShell>
  );
}
