const $ = (s) => document.querySelector(s);
let currentUser = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function renderAuthArea() {
  const area = $("#auth-area");
  if (currentUser) {
    area.innerHTML = `<span class="user-tag">${currentUser}</span><button class="logout-btn" onclick="logout()">Log Out</button>`;
    $("#login-section").hidden = true;
    $("#new-trade-section").hidden = false;
  } else {
    area.innerHTML = "";
    $("#login-section").hidden = false;
    $("#new-trade-section").hidden = true;
  }
}

async function checkSession() {
  const { user } = await api("/api/me");
  currentUser = user?.username || null;
  renderAuthArea();
}

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await doAuth("login");
});

async function doAuth(action) {
  const username = $("#username").value.trim();
  const password = $("#password").value;
  $("#auth-error").textContent = "";
  try {
    const data = await api(`/api/${action}`, { method: "POST", body: { username, password } });
    currentUser = data.username;
    renderAuthArea();
    loadTrades();
  } catch (err) {
    $("#auth-error").textContent = err.message;
  }
}

async function logout() {
  await api("/api/logout", { method: "POST" });
  currentUser = null;
  renderAuthArea();
}

$("#trade-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const offering = $("#offering").value.trim();
  const wanting = $("#wanting").value.trim();
  const details = $("#details").value.trim();
  if (!offering || !wanting) return;
  await api("/api/trades", { method: "POST", body: { offering, wanting, details } });
  $("#trade-form").reset();
  loadTrades();
});

async function updateStatus(id, status) {
  await api(`/api/trades/${id}`, { method: "PATCH", body: { status } });
  loadTrades();
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr + "Z").getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function loadTrades() {
  const trades = await api("/api/trades");
  const list = $("#trades-list");
  if (!trades.length) {
    list.innerHTML = '<p class="muted">No trades yet. Be the first!</p>';
    return;
  }
  list.innerHTML = trades.map((t) => `
    <div class="trade-item">
      <div class="trade-header">
        <span class="trade-user">${esc(t.username)}</span>
        <span class="trade-time">${timeAgo(t.created_at)}</span>
      </div>
      <div class="trade-offer">
        <span class="label">HAS</span> ${esc(t.offering)}
        <span class="arrow">→</span>
        <span class="label">WANTS</span> ${esc(t.wanting)}
      </div>
      ${t.details ? `<div class="trade-details">${esc(t.details)}</div>` : ""}
      <div class="trade-footer">
        <span class="status status-${t.status}">${t.status}</span>
        ${t.username === currentUser && t.status === "open" ? `
          <div>
            <button class="status-btn" onclick="updateStatus(${t.id},'completed')">Mark Done</button>
            <button class="status-btn" onclick="updateStatus(${t.id},'closed')">Close</button>
          </div>
        ` : ""}
      </div>
    </div>
  `).join("");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

checkSession();
loadTrades();
