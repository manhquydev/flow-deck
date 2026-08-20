const POLL_MS = 2000;
const SECRET_KEYS = /session|tty|transcript|pts\//i;

const bodyEl = document.getElementById("board-body");
const projectPill = document.getElementById("project-pill");
const clockPill = document.getElementById("clock-pill");
const errEl = document.getElementById("err");
const waveEl = document.getElementById("wave-text");
const copyBtn = document.getElementById("copy-wave");

let checking = new Set();
let waveCache = "";
let boardTimer = 0;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortPath(p) {
  if (!p) return "—";
  const parts = String(p).split(/[/\\]/);
  if (parts.length <= 3) return p;
  return "…/" + parts.slice(-3).join("/");
}

function fmtCheck(row) {
  const last = row.lastCheck;
  if (!last) return "—";
  const t = last.at ? new Date(last.at).toLocaleTimeString() : "";
  const core = last.rc === 0 ? `pass ${t}` : `fail rc=${last.rc} ${t}`;
  return last.cwdUnsafe ? `${core} · cwd=root (unsafe)` : core;
}

function worktreeCell(row) {
  if (row.cwdUnsafe && !row.worktree) {
    return `<span class="wt unsafe">cwd=root (unsafe)</span>`;
  }
  const label = shortPath(row.worktree);
  const extra = row.cwdUnsafe ? " · cwd=root (unsafe)" : "";
  const cls = row.cwdUnsafe ? "wt unsafe" : "wt";
  return `<span class="${cls}" title="${esc(row.worktree || "")}">${esc(label)}${esc(extra)}</span>`;
}

function sanitizeRow(row) {
  const out = { ...row };
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS.test(k)) delete out[k];
  }
  return out;
}

function renderBoard(board) {
  if (!board || board.error) {
    bodyEl.innerHTML = `<tr><td colspan="7" class="empty">${esc(board?.error || "no flow project here")}</td></tr>`;
    projectPill.textContent = "project —";
    return;
  }
  projectPill.textContent = "project " + shortPath(board.root);
  const rows = board.rows || [];
  if (!rows.length) {
    bodyEl.innerHTML = `<tr><td colspan="7" class="empty">No cards found.</td></tr>`;
    return;
  }
  bodyEl.innerHTML = rows.map((raw) => {
    const row = sanitizeRow(raw);
    const busy = checking.has(row.id);
    const flags = [];
    if (row.flags?.hostMuxBlocked) flags.push("host/mux");
    if (row.flags?.subagentBlocked) flags.push("subagent");
    const flagHtml = flags.length
      ? `<div class="check">${esc(flags.join(" · "))}</div>`
      : "";
    return `<tr data-id="${esc(row.id)}">
      <td class="id">${esc(row.id)}</td>
      <td class="title">${esc(row.title)}</td>
      <td>${worktreeCell(row)}</td>
      <td class="vendor">${esc(row.vendor || "—")}</td>
      <td><span class="badge ${esc(row.state)}">${esc(row.state)}</span>${flagHtml}</td>
      <td class="check">${esc(fmtCheck(row))}</td>
      <td><button class="check-btn" data-check="${esc(row.id)}" ${busy ? "disabled" : ""}>${busy ? "…" : "Check"}</button></td>
    </tr>`;
  }).join("");
}

async function loadBoard() {
  try {
    const res = await fetch("/api/board", { cache: "no-store" });
    const data = await res.json();
    renderBoard(data);
    errEl.hidden = true;
    clockPill.textContent = "poll 2s · " + new Date().toLocaleTimeString();
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent = String(err.message || err);
  }
}

async function loadWave() {
  try {
    const res = await fetch("/api/wave", { cache: "no-store" });
    const data = await res.json();
    if (data.error) {
      waveCache = data.error;
    } else if (Array.isArray(data.blocks) && data.blocks.length) {
      waveCache = data.blocks.map((b) => b.text).join("\n\n") + "\n";
    } else {
      const blocked = (data.blocked || []).join(", ");
      waveCache = `No buildable cards.${blocked ? "\nready-blocked: " + blocked : ""}\n`;
    }
    waveEl.textContent = waveCache;
  } catch (err) {
    waveEl.textContent = String(err.message || err);
  }
}

async function runCheck(id) {
  checking.add(id);
  loadBoard();
  try {
    const res = await fetch("/api/check/" + encodeURIComponent(id), { method: "POST" });
    await res.json();
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent = String(err.message || err);
  } finally {
    checking.delete(id);
    await loadBoard();
  }
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b === btn));
    const view = btn.dataset.view;
    document.getElementById("view-board").classList.toggle("on", view === "board");
    document.getElementById("view-wave").classList.toggle("on", view === "wave");
    if (view === "wave") loadWave();
  });
});

bodyEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-check]");
  if (!btn) return;
  runCheck(btn.getAttribute("data-check"));
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(waveCache || waveEl.textContent || "");
    copyBtn.textContent = "Copied";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
  } catch {
    copyBtn.textContent = "Copy failed";
  }
});

loadBoard();
loadWave();
boardTimer = setInterval(loadBoard, POLL_MS);
void boardTimer;
