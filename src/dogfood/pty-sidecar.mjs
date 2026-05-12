import { createRequire } from "node:module";
import process from "node:process";

const options = JSON.parse(process.argv[2] ?? "{}");
const root = options.root ?? process.env.AGENTCTL_REPO_ROOT ?? process.cwd();
const require = createRequire(`${root}/package.json`);
const pty = require("node-pty");

const send = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined),
);
Object.assign(env, options.env ?? {});

const terminal = pty.spawn("bash", ["-lc", options.command], {
  name: "xterm-256color",
  cols: Number(options.cols ?? 100),
  rows: Number(options.rows ?? 30),
  cwd: options.cwd ?? process.cwd(),
  env,
});

terminal.onData((data) => {
  send({ type: "data", data: Buffer.from(data, "utf8").toString("base64") });
});

terminal.onExit((event) => {
  send({ type: "exit", exitCode: event.exitCode, signal: event.signal });
  process.exit(event.exitCode ?? 0);
});

process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        const message = JSON.parse(line);
        if (message.type === "resize") {
          terminal.resize(Number(message.cols), Number(message.rows));
        }
        if (message.type === "input" && typeof message.data === "string") {
          terminal.write(Buffer.from(message.data, "base64").toString("utf8"));
        }
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
    index = buffer.indexOf("\n");
  }
});

process.on("SIGTERM", () => terminal.kill());
process.on("SIGINT", () => terminal.kill());
