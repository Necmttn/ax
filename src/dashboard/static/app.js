const view = document.querySelector("#view");
const status = document.querySelector("#status");

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function table(rows) {
  const flat = Array.isArray(rows?.[0]) ? rows.flat() : rows;
  if (!Array.isArray(flat) || flat.length === 0) return "<p class='empty'>No rows.</p>";
  const keys = Object.keys(flat[0]);
  return `<table><thead><tr>${keys.map((k) => `<th>${k}</th>`).join("")}</tr></thead><tbody>${flat
    .map((row) => `<tr>${keys.map((k) => `<td><code>${String(row[k] ?? "")}</code></td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

async function showHealth() {
  view.innerHTML = "<h2>Graph Health</h2><p>Loading...</p>";
  view.innerHTML = `<h2>Graph Health</h2>${table(await fetchJson("/api/graph-health"))}`;
}

async function showWorktrees() {
  view.innerHTML = "<h2>Worktrees</h2><p>Loading...</p>";
  view.innerHTML = `<h2>Worktrees</h2>${table(await fetchJson("/api/worktrees"))}`;
}

async function showSelfImprove() {
  view.innerHTML = "<h2>Self-Improve</h2><p>Loading...</p>";
  view.innerHTML = `<h2>Self-Improve</h2>${table(await fetchJson("/api/self-improve"))}`;
}

function showIngest() {
  view.innerHTML = "<h2>Ingest Live</h2><ol id='events'></ol>";
}

function showQuery() {
  view.innerHTML = `<h2>Query Workbench</h2><textarea id="sql" spellcheck="false">SELECT * FROM session LIMIT 5;</textarea><button id="run">Run</button><section id="result"></section>`;
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const selected = target.dataset.view;
  if (selected === "ingest") showIngest();
  if (selected === "health") await showHealth();
  if (selected === "worktrees") await showWorktrees();
  if (selected === "self-improve") await showSelfImprove();
  if (selected === "query") showQuery();
});

status.textContent = "ready";
showIngest();

const events = new EventSource("/api/events");
events.addEventListener("ready", (event) => {
  status.textContent = `live ${JSON.parse(event.data).ts}`;
});
events.addEventListener("ingest_event", (event) => {
  const list = document.querySelector("#events");
  if (!list) return;
  const item = document.createElement("li");
  item.textContent = event.data;
  list.prepend(item);
});
events.onerror = () => {
  status.textContent = "live stream disconnected";
};

async function fetchJsonPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.id !== "run") return;
  const sql = document.querySelector("#sql").value;
  const result = document.querySelector("#result");
  result.textContent = "running";
  try {
    const json = await fetchJsonPost("/api/query", { sql });
    result.innerHTML = table(json.result);
  } catch (error) {
    result.innerHTML = `<pre>${String(error.message ?? error)}</pre>`;
  }
});
