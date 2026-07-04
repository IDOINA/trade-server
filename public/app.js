const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let currentUser = null;
let presets = {};
let presetTarget = null;

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

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

function timeAgo(d) {
  const diff = Date.now() - new Date(d + "Z").getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

// ── Navigation ──

const pages = ["auth", "trades", "create", "trade-detail", "inbox", "profile", "report"];

function showPage(name) {
  pages.forEach(p => {
    const el = $(`#page-${p}`);
    if (el) el.hidden = p !== name;
  });
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === name));
}

function navigate(page, data) {
  if (!currentUser && !["auth", "trades"].includes(page)) return navigate("auth");
  if (page === "trades") { showPage("trades"); loadTrades(); }
  else if (page === "create") { showPage("create"); }
  else if (page === "trade-detail") { showPage("trade-detail"); loadTradeDetail(data); }
  else if (page === "inbox") { showPage("inbox"); loadInbox(); }
  else if (page === "profile") { showPage("profile"); loadProfile(data); }
  else if (page === "report") { showPage("report"); if (data) $("#report-user").value = data; }
  else { showPage("auth"); }
}

$$(".nav-btn").forEach(b => b.addEventListener("click", () => navigate(b.dataset.page)));

// ── Auth ──

function renderAuthArea() {
  const a = $("#auth-area");
  if (currentUser) {
    a.innerHTML = `<span class="user-tag" onclick="navigate('profile','${esc(currentUser.username)}')">${esc(currentUser.username)}</span><button class="btn-gray btn-small" onclick="logout()">Log Out</button>`;
    $("#main-nav").hidden = false;
    showPage("trades");
    loadTrades();
  } else {
    a.innerHTML = "";
    $("#main-nav").hidden = true;
    showPage("auth");
  }
}

async function checkSession() {
  const { user } = await api("/api/me");
  currentUser = user;
  renderAuthArea();
}

$$(".auth-tab").forEach(t => t.addEventListener("click", () => {
  $$(".auth-tab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  $("#login-form").hidden = t.dataset.tab !== "login";
  $("#register-form").hidden = t.dataset.tab !== "register";
  $("#auth-error").textContent = "";
}));

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#auth-error").textContent = "";
  try {
    const data = await api("/api/login", { method: "POST", body: {
      username: $("#login-user").value.trim(),
      password: $("#login-pass").value,
    }});
    currentUser = { username: data.username };
    renderAuthArea();
  } catch (err) { $("#auth-error").textContent = err.message; }
});

$("#register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#auth-error").textContent = "";
  try {
    const data = await api("/api/register", { method: "POST", body: {
      username: $("#reg-user").value.trim(),
      email: $("#reg-email").value.trim(),
      password: $("#reg-pass").value,
    }});
    currentUser = { username: data.username };
    renderAuthArea();
  } catch (err) { $("#auth-error").textContent = err.message; }
});

async function logout() {
  await api("/api/logout", { method: "POST" });
  currentUser = null;
  renderAuthArea();
}

// Password strength
$("#reg-pass").addEventListener("input", (e) => {
  const pw = e.target.value;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  const bar = $("#pw-bar");
  const txt = $("#pw-text");
  const pct = Math.min(score / 5 * 100, 100);
  bar.style.width = pct + "%";
  if (score <= 1) { bar.style.background = "#e94560"; txt.textContent = "Weak"; txt.style.color = "#e94560"; }
  else if (score <= 3) { bar.style.background = "#f5a623"; txt.textContent = "Medium"; txt.style.color = "#f5a623"; }
  else { bar.style.background = "#16c79a"; txt.textContent = "Strong"; txt.style.color = "#16c79a"; }
  if (!pw) { bar.style.width = "0"; txt.textContent = ""; }
});

// ── Trades ──

async function loadTrades() {
  const cat = $("#cat-filter").value;
  const search = $("#search-input").value.trim();
  let url = "/api/trades?";
  if (cat !== "all") url += "category=" + cat + "&";
  if (search) url += "search=" + encodeURIComponent(search);
  const trades = await api(url);
  const list = $("#trades-list");
  if (!trades.length) { list.innerHTML = '<p class="muted">No trades yet.</p>'; return; }
  list.innerHTML = trades.map(t => `
    <div class="trade-item" onclick="navigate('trade-detail',${t.id})">
      <div class="trade-header">
        <span>
          <span class="trade-user" onclick="event.stopPropagation();navigate('profile','${esc(t.username)}')">${esc(t.username)}</span>
          <span class="trade-cat">${esc(t.category)}</span>
        </span>
        <span class="trade-time">${timeAgo(t.created_at)}</span>
      </div>
      <div class="trade-offer">
        <span class="lbl">HAS</span> ${esc(t.offering)}
        <span class="arrow">&rarr;</span>
        <span class="lbl">WANTS</span> ${esc(t.wanting)}
      </div>
      ${t.details ? `<div class="trade-details">${esc(t.details)}</div>` : ""}
      ${t.image ? `<img class="trade-img" src="${t.image}" alt="trade image">` : ""}
      <div class="trade-footer">
        <span class="status status-${t.status}">${t.status}</span>
      </div>
    </div>
  `).join("");
}

let searchTimeout;
$("#search-input").addEventListener("input", () => { clearTimeout(searchTimeout); searchTimeout = setTimeout(loadTrades, 300); });
$("#cat-filter").addEventListener("change", loadTrades);

// ── Create Trade ──

let tradeImageData = null;

$("#trade-image").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) { tradeImageData = null; $("#trade-img-preview").innerHTML = ""; return; }
  tradeImageData = await compressImage(file, 300, 0.6);
  $("#trade-img-preview").innerHTML = `<img src="${tradeImageData}">`;
});

$("#trade-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/trades", { method: "POST", body: {
      offering: $("#trade-offering").value.trim(),
      wanting: $("#trade-wanting").value.trim(),
      details: $("#trade-details").value.trim(),
      image: tradeImageData,
      category: $("#trade-cat").value,
    }});
    $("#trade-form").reset();
    tradeImageData = null;
    $("#trade-img-preview").innerHTML = "";
    navigate("trades");
  } catch (err) { alert(err.message); }
});

// ── Trade Detail ──

async function loadTradeDetail(id) {
  const trade = await api(`/api/trades/${id}`);
  const isOwner = currentUser && currentUser.username === trade.username;
  const isBuyer = currentUser && currentUser.username === trade.buyer_name;

  let actions = "";
  if (currentUser) {
    if (trade.status === "open" && !isOwner) {
      actions += `<button class="btn-green btn-small" onclick="acceptTrade(${id})">Accept Trade</button> `;
    }
    if (trade.status === "open" && isOwner) {
      actions += `<button class="btn-red btn-small" onclick="closeTrade(${id})">Close</button> `;
    }
    if (trade.status === "pending" && (isOwner || isBuyer)) {
      const who = isOwner ? "seller" : "buyer";
      const confirmed = isOwner ? trade.seller_confirmed : trade.buyer_confirmed;
      if (!Number(confirmed)) {
        actions += `<button class="btn-green btn-small" onclick="confirmTrade(${id})">Confirm Completed</button> `;
      } else {
        actions += `<span class="muted">Waiting for other party...</span> `;
      }
    }
    if (!isOwner && trade.username) {
      actions += `<button class="btn-gray btn-small" onclick="navigate('report','${esc(trade.username)}')">Report</button> `;
      actions += `<button class="btn-gray btn-small" onclick="blockUser('${esc(trade.username)}')">Block</button> `;
    }
  }

  $("#trade-detail-content").innerHTML = `
    <div class="trade-header">
      <span>
        <span class="trade-user" onclick="navigate('profile','${esc(trade.username)}')">${esc(trade.username)}</span>
        <span class="trade-cat">${esc(trade.category)}</span>
      </span>
      <span class="trade-time">${timeAgo(trade.created_at)}</span>
    </div>
    <div class="trade-offer" style="font-size:1rem;margin:0.8rem 0">
      <span class="lbl">HAS</span> <strong>${esc(trade.offering)}</strong>
      <span class="arrow">&rarr;</span>
      <span class="lbl">WANTS</span> <strong>${esc(trade.wanting)}</strong>
    </div>
    ${trade.details ? `<div class="trade-details">${esc(trade.details)}</div>` : ""}
    ${trade.image ? `<img class="trade-img" src="${trade.image}" alt="trade image">` : ""}
    <div class="trade-footer" style="margin-top:0.8rem">
      <span class="status status-${trade.status}">${trade.status}</span>
      ${trade.buyer_name ? `<span class="muted">Buyer: <strong>${esc(trade.buyer_name)}</strong></span>` : ""}
    </div>
    <div class="btn-row" style="margin-top:0.8rem">${actions}</div>
  `;

  loadMessages(id);
}

async function acceptTrade(id) {
  try { await api(`/api/trades/${id}/accept`, { method: "POST" }); loadTradeDetail(id); }
  catch (err) { alert(err.message); }
}

async function confirmTrade(id) {
  try {
    const r = await api(`/api/trades/${id}/confirm`, { method: "POST" });
    if (r.completed) alert("Trade completed! Don't forget to leave a vouch.");
    loadTradeDetail(id);
  } catch (err) { alert(err.message); }
}

async function closeTrade(id) {
  try { await api(`/api/trades/${id}/close`, { method: "POST" }); loadTradeDetail(id); }
  catch (err) { alert(err.message); }
}

// ── Messages ──

async function loadMessages(tradeId) {
  if (!currentUser) { $("#trade-messages").hidden = true; return; }
  $("#trade-messages").hidden = false;
  const msgs = await api(`/api/trades/${tradeId}/messages`);
  const list = $("#msg-list");
  if (!msgs.length) { list.innerHTML = '<p class="muted">No messages yet.</p>'; }
  else {
    list.innerHTML = msgs.map(m => `
      <div class="msg-item">
        <span class="msg-sender">${esc(m.username)}</span>
        <span class="msg-time">${timeAgo(m.created_at)}</span>
        <div class="msg-content">${esc(m.content)}</div>
      </div>
    `).join("");
    list.scrollTop = list.scrollHeight;
  }

  $("#msg-form").onsubmit = async (e) => {
    e.preventDefault();
    const input = $("#msg-input");
    if (!input.value.trim()) return;
    try {
      await api(`/api/trades/${tradeId}/messages`, { method: "POST", body: { content: input.value.trim() } });
      input.value = "";
      loadMessages(tradeId);
    } catch (err) { alert(err.message); }
  };
}

async function loadInbox() {
  const convos = await api("/api/my-messages");
  const list = $("#inbox-list");
  if (!convos.length) { list.innerHTML = '<p class="muted">No conversations yet.</p>'; return; }
  list.innerHTML = convos.map(c => `
    <div class="inbox-item" onclick="navigate('trade-detail',${c.trade_id})">
      <div class="inbox-trade">${esc(c.offering)} &rarr; ${esc(c.wanting)} <span class="status status-${c.status}">${c.status}</span></div>
      <div class="inbox-last"><strong>${esc(c.last_sender || "")}:</strong> ${esc(c.last_message || "")}</div>
    </div>
  `).join("");
}

// ── Profile ──

async function loadProfile(username) {
  showPage("profile");
  try {
    const u = await api(`/api/users/${username}`);
    const isMe = currentUser && currentUser.username === username;

    let actions = "";
    if (currentUser && !isMe) {
      actions = `
        <div class="btn-row" style="margin-bottom:1rem">
          <button class="btn-green btn-small" onclick="giveVouch('${esc(username)}','positive')">+ Vouch</button>
          <button class="btn-red btn-small" onclick="giveVouch('${esc(username)}','scam')">Scam Vouch</button>
          <button class="btn-gray btn-small" onclick="blockUser('${esc(username)}')">Block</button>
          <button class="btn-gray btn-small" onclick="navigate('report','${esc(username)}')">Report</button>
        </div>
      `;
    }

    const vouchList = u.vouches.length ? u.vouches.map(v => `
      <div class="vouch-item">
        <div>
          <span class="trade-user" onclick="navigate('profile','${esc(v.voucher_name)}')">${esc(v.voucher_name)}</span>
          <span class="rep-badge ${v.type === 'positive' ? 'rep-positive' : 'rep-scam'}">${v.type === 'positive' ? '+1' : 'SCAM'}</span>
          ${v.comment ? `<div class="muted" style="margin-top:0.2rem">${esc(v.comment)}</div>` : ""}
        </div>
        <span class="trade-time">${timeAgo(v.created_at)}</span>
      </div>
    `).join("") : '<p class="muted">No vouches yet.</p>';

    let reportsHtml = "";
    if (u.scam_reports > 0) {
      const reports = await api(`/api/users/${username}/reports`);
      reportsHtml = `<h3 style="color:#e94560;margin-top:1rem">Scam Reports (${reports.length})</h3>` +
        reports.map(r => `
          <div class="report-item">
            <strong>${esc(r.reporter_name)}</strong> <span class="trade-time">${timeAgo(r.created_at)}</span>
            <div style="margin-top:0.3rem">${esc(r.reason)}</div>
            ${r.evidence_url ? `<div><a href="${esc(r.evidence_url)}" target="_blank" style="color:#4a9ff5">Video proof</a></div>` : ""}
            ${r.evidence_image ? `<img src="${r.evidence_image}" alt="evidence">` : ""}
          </div>
        `).join("");
    }

    $("#profile-content").innerHTML = `
      <div class="card">
        <div class="profile-header">
          <div class="profile-avatar">${esc(username[0].toUpperCase())}</div>
          <div>
            <h2 style="margin-bottom:0.2rem">${esc(username)}</h2>
            <span class="muted">Joined ${timeAgo(u.created_at)}</span>
          </div>
        </div>
        <div class="profile-stats">
          <div class="stat-box">
            <div class="stat-num" style="color:#16c79a">${u.positive_vouches}</div>
            <div class="stat-label">Vouches</div>
          </div>
          <div class="stat-box">
            <div class="stat-num" style="color:#e94560">${u.scam_vouches}</div>
            <div class="stat-label">Scam Vouches</div>
          </div>
          <div class="stat-box">
            <div class="stat-num">${u.completed_trades}</div>
            <div class="stat-label">Trades</div>
          </div>
          <div class="stat-box">
            <div class="stat-num" style="color:${u.scam_reports > 0 ? '#e94560' : '#888'}">${u.scam_reports}</div>
            <div class="stat-label">Reports</div>
          </div>
        </div>
        ${actions}
        <h3>Vouches</h3>
        ${vouchList}
        ${reportsHtml}
      </div>
    `;
  } catch (err) {
    $("#profile-content").innerHTML = `<div class="card"><p class="error">${err.message}</p></div>`;
  }
}

async function giveVouch(username, type) {
  const comment = prompt(`Leave a comment for your ${type} vouch (optional):`);
  try {
    await api(`/api/users/${username}/vouch`, { method: "POST", body: { type, comment: comment || "" } });
    loadProfile(username);
  } catch (err) { alert(err.message); }
}

async function blockUser(username) {
  if (!confirm(`Block ${username}? They won't be able to message you or accept your trades.`)) return;
  try { await api(`/api/users/${username}/block`, { method: "POST" }); alert("Blocked."); }
  catch (err) { alert(err.message); }
}

// ── Report ──

let reportImageData = null;
$("#report-image").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  reportImageData = file ? await compressImage(file, 400, 0.7) : null;
});

$("#report-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/report", { method: "POST", body: {
      reported_username: $("#report-user").value.trim(),
      trade_id: $("#report-trade-id").value.trim() || null,
      reason: $("#report-reason").value.trim(),
      evidence_url: $("#report-evidence-url").value.trim() || null,
      evidence_image: reportImageData,
    }});
    alert("Report submitted. If 3+ people report this user, they'll be muted for 1 hour.");
    $("#report-form").reset();
    reportImageData = null;
    navigate("trades");
  } catch (err) { alert(err.message); }
});

// ── Presets ──

async function loadPresets() {
  presets = await api("/api/presets");
}

function openPresetPicker(target) {
  presetTarget = target;
  const modal = $("#preset-modal");
  modal.hidden = false;
  const cats = Object.keys(presets);
  $("#preset-tabs").innerHTML = cats.map((c, i) =>
    `<button class="preset-tab ${i === 0 ? 'active' : ''}" onclick="showPresetCat('${c}')">${c}</button>`
  ).join("");
  showPresetCat(cats[0]);
}

function showPresetCat(cat) {
  $$(".preset-tab").forEach(t => t.classList.toggle("active", t.textContent === cat));
  const items = presets[cat] || [];
  $("#preset-items").innerHTML = `<div class="preset-grid">${items.map(p => `
    <div class="preset-item rarity-${p.rarity}" onclick="pickPreset('${esc(p.emoji)} ${esc(p.name)}')">
      <span class="preset-emoji">${p.emoji}</span>
      <span class="preset-name">${esc(p.name)}</span>
    </div>
  `).join("")}</div>`;
}

function pickPreset(val) {
  const field = presetTarget === "offering" ? "#trade-offering" : "#trade-wanting";
  const cur = $(field).value;
  $(field).value = cur ? cur + ", " + val : val;
  closePresetModal();
}

function closePresetModal() { $("#preset-modal").hidden = true; }

// ── Image compression ──

function compressImage(file, maxDim, quality) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Init ──

checkSession();
loadPresets();
