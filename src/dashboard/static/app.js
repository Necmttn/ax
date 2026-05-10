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
  if (selected === "query") showQuery();
});

status.textContent = "ready";
showIngest();
