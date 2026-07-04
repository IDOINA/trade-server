const express = require("express");
const session = require("express-session");
const { createClient } = require("@libsql/client");
const crypto = require("crypto");
const path = require("path");

const app = express();

const db = createClient({
  url: process.env.DATABASE_URL || "file:trades.db",
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

async function initDB() {
  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    ip TEXT,
    muted_until TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    offering TEXT NOT NULL,
    wanting TEXT NOT NULL,
    details TEXT,
    image TEXT,
    category TEXT DEFAULT 'other',
    status TEXT DEFAULT 'open',
    buyer_id INTEGER,
    seller_confirmed INTEGER DEFAULT 0,
    buyer_confirmed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (trade_id) REFERENCES trades(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS vouches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL,
    vouched_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    comment TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (voucher_id) REFERENCES users(id),
    FOREIGN KEY (vouched_id) REFERENCES users(id)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (blocker_id) REFERENCES users(id),
    FOREIGN KEY (blocked_id) REFERENCES users(id)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS scam_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL,
    reported_id INTEGER NOT NULL,
    trade_id INTEGER,
    reason TEXT NOT NULL,
    evidence_url TEXT,
    evidence_image TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (reporter_id) REFERENCES users(id),
    FOREIGN KEY (reported_id) REFERENCES users(id)
  )`);
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString("hex");
}

function getIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
}

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
  next();
}

async function muteCheck(req, res, next) {
  if (!req.session.userId) return next();
  const r = await db.execute({ sql: "SELECT muted_until FROM users WHERE id = ?", args: [req.session.userId] });
  const u = r.rows[0];
  if (u?.muted_until && new Date(u.muted_until + "Z") > new Date()) {
    return res.status(403).json({ error: "You are muted until " + u.muted_until + " UTC" });
  }
  next();
}

// ── Auth ──

app.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "All fields required" });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: "Username must be 3-20 chars" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be 8+ chars" });
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password))
    return res.status(400).json({ error: "Password needs uppercase, lowercase, and number" });

  const exists = await db.execute({ sql: "SELECT id FROM users WHERE username = ? OR email = ?", args: [username, email] });
  if (exists.rows.length) return res.status(409).json({ error: "Username or email taken" });

  const salt = crypto.randomBytes(16).toString("hex");
  const result = await db.execute({
    sql: "INSERT INTO users (username, email, password_hash, salt, ip) VALUES (?, ?, ?, ?, ?)",
    args: [username, email, hashPassword(password, salt), salt, getIp(req)],
  });
  req.session.userId = Number(result.lastInsertRowid);
  req.session.username = username;
  res.json({ username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "All fields required" });
  const r = await db.execute({ sql: "SELECT * FROM users WHERE username = ?", args: [username] });
  const user = r.rows[0];
  if (!user || hashPassword(password, user.salt) !== user.password_hash)
    return res.status(401).json({ error: "Invalid credentials" });
  await db.execute({ sql: "UPDATE users SET ip = ? WHERE id = ?", args: [getIp(req), user.id] });
  req.session.userId = Number(user.id);
  req.session.username = user.username;
  res.json({ username: user.username });
});

app.post("/api/logout", (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: { id: req.session.userId, username: req.session.username } });
});

// ── User profile ──

app.get("/api/users/:username", async (req, res) => {
  const r = await db.execute({ sql: "SELECT id, username, created_at FROM users WHERE username = ?", args: [req.params.username] });
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });

  const vouches = await db.execute({ sql: `SELECT vouches.*, users.username AS voucher_name FROM vouches JOIN users ON vouches.voucher_id = users.id WHERE vouched_id = ? ORDER BY vouches.created_at DESC`, args: [user.id] });
  const positive = vouches.rows.filter(v => v.type === "positive").length;
  const scam = vouches.rows.filter(v => v.type === "scam").length;
  const trades = await db.execute({ sql: "SELECT COUNT(*) as count FROM trades WHERE user_id = ? AND status = 'completed'", args: [user.id] });
  const reports = await db.execute({ sql: "SELECT COUNT(*) as count FROM scam_reports WHERE reported_id = ?", args: [user.id] });

  res.json({
    ...user,
    vouches: vouches.rows,
    positive_vouches: positive,
    scam_vouches: scam,
    completed_trades: Number(trades.rows[0].count),
    scam_reports: Number(reports.rows[0].count),
  });
});

// ── Trades ──

app.get("/api/trades", async (req, res) => {
  const { category, search } = req.query;
  let sql = "SELECT trades.*, users.username FROM trades JOIN users ON trades.user_id = users.id";
  const conditions = [];
  const args = [];
  if (category && category !== "all") { conditions.push("trades.category = ?"); args.push(category); }
  if (search) { conditions.push("(trades.offering LIKE ? OR trades.wanting LIKE ?)"); args.push(`%${search}%`, `%${search}%`); }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY trades.created_at DESC";
  const r = await db.execute({ sql, args });
  res.json(r.rows);
});

app.get("/api/trades/:id", async (req, res) => {
  const r = await db.execute({ sql: `SELECT trades.*, users.username, (SELECT username FROM users WHERE id = trades.buyer_id) AS buyer_name FROM trades JOIN users ON trades.user_id = users.id WHERE trades.id = ?`, args: [req.params.id] });
  if (!r.rows.length) return res.status(404).json({ error: "Trade not found" });
  res.json(r.rows[0]);
});

app.post("/api/trades", auth, muteCheck, async (req, res) => {
  const { offering, wanting, details, image, category } = req.body;
  if (!offering || !wanting) return res.status(400).json({ error: "Offering and wanting required" });
  const imgData = image && image.length < 500000 ? image : null;
  const result = await db.execute({
    sql: "INSERT INTO trades (user_id, offering, wanting, details, image, category) VALUES (?, ?, ?, ?, ?, ?)",
    args: [req.session.userId, offering.slice(0, 200), wanting.slice(0, 200), (details || "").slice(0, 500), imgData, category || "other"],
  });
  const t = await db.execute({ sql: "SELECT trades.*, users.username FROM trades JOIN users ON trades.user_id = users.id WHERE trades.id = ?", args: [result.lastInsertRowid] });
  res.json(t.rows[0]);
});

app.post("/api/trades/:id/accept", auth, async (req, res) => {
  const r = await db.execute({ sql: "SELECT * FROM trades WHERE id = ?", args: [req.params.id] });
  const trade = r.rows[0];
  if (!trade) return res.status(404).json({ error: "Not found" });
  if (Number(trade.user_id) === req.session.userId) return res.status(400).json({ error: "Can't accept your own trade" });
  if (trade.status !== "open") return res.status(400).json({ error: "Trade not open" });

  const blocked = await db.execute({ sql: "SELECT id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)", args: [trade.user_id, req.session.userId, req.session.userId, trade.user_id] });
  if (blocked.rows.length) return res.status(403).json({ error: "Blocked" });

  await db.execute({ sql: "UPDATE trades SET buyer_id = ?, status = 'pending' WHERE id = ?", args: [req.session.userId, req.params.id] });
  res.json({ ok: true });
});

app.post("/api/trades/:id/confirm", auth, async (req, res) => {
  const r = await db.execute({ sql: "SELECT * FROM trades WHERE id = ?", args: [req.params.id] });
  const trade = r.rows[0];
  if (!trade || trade.status !== "pending") return res.status(400).json({ error: "Trade not pending" });

  const isSeller = Number(trade.user_id) === req.session.userId;
  const isBuyer = Number(trade.buyer_id) === req.session.userId;
  if (!isSeller && !isBuyer) return res.status(403).json({ error: "Not your trade" });

  if (isSeller) await db.execute({ sql: "UPDATE trades SET seller_confirmed = 1 WHERE id = ?", args: [req.params.id] });
  if (isBuyer) await db.execute({ sql: "UPDATE trades SET buyer_confirmed = 1 WHERE id = ?", args: [req.params.id] });

  const updated = await db.execute({ sql: "SELECT * FROM trades WHERE id = ?", args: [req.params.id] });
  const t = updated.rows[0];
  if (Number(t.seller_confirmed) && Number(t.buyer_confirmed)) {
    await db.execute({ sql: "UPDATE trades SET status = 'completed' WHERE id = ?", args: [req.params.id] });
  }
  res.json({ ok: true, completed: Number(t.seller_confirmed) && Number(t.buyer_confirmed) });
});

app.post("/api/trades/:id/close", auth, async (req, res) => {
  const r = await db.execute({ sql: "SELECT * FROM trades WHERE id = ?", args: [req.params.id] });
  const trade = r.rows[0];
  if (!trade) return res.status(404).json({ error: "Not found" });
  if (Number(trade.user_id) !== req.session.userId) return res.status(403).json({ error: "Not your trade" });
  await db.execute({ sql: "UPDATE trades SET status = 'closed' WHERE id = ?", args: [req.params.id] });
  res.json({ ok: true });
});

// ── Messages ──

app.get("/api/trades/:id/messages", auth, async (req, res) => {
  const r = await db.execute({ sql: `SELECT messages.*, users.username FROM messages JOIN users ON messages.sender_id = users.id WHERE messages.trade_id = ? ORDER BY messages.created_at ASC`, args: [req.params.id] });
  res.json(r.rows);
});

app.post("/api/trades/:id/messages", auth, muteCheck, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "Message required" });

  const trade = await db.execute({ sql: "SELECT * FROM trades WHERE id = ?", args: [req.params.id] });
  if (!trade.rows.length) return res.status(404).json({ error: "Trade not found" });

  const blocked = await db.execute({ sql: "SELECT id FROM blocks WHERE blocker_id = ? AND blocked_id = ?", args: [trade.rows[0].user_id, req.session.userId] });
  if (blocked.rows.length) return res.status(403).json({ error: "You are blocked by this user" });

  await db.execute({
    sql: "INSERT INTO messages (trade_id, sender_id, content) VALUES (?, ?, ?)",
    args: [req.params.id, req.session.userId, content.slice(0, 1000)],
  });
  res.json({ ok: true });
});

app.get("/api/my-messages", auth, async (req, res) => {
  const r = await db.execute({ sql: `
    SELECT DISTINCT trades.id as trade_id, trades.offering, trades.wanting, trades.status,
      (SELECT content FROM messages WHERE trade_id = trades.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT username FROM users JOIN messages ON users.id = messages.sender_id WHERE messages.trade_id = trades.id ORDER BY messages.created_at DESC LIMIT 1) as last_sender
    FROM trades JOIN messages ON trades.id = messages.trade_id
    WHERE trades.user_id = ? OR messages.sender_id = ? OR trades.buyer_id = ?
    ORDER BY (SELECT MAX(created_at) FROM messages WHERE trade_id = trades.id) DESC
  `, args: [req.session.userId, req.session.userId, req.session.userId] });
  res.json(r.rows);
});

// ── Vouches ──

app.post("/api/users/:username/vouch", auth, muteCheck, async (req, res) => {
  const { type, comment } = req.body;
  if (!["positive", "scam"].includes(type)) return res.status(400).json({ error: "Invalid vouch type" });

  const target = await db.execute({ sql: "SELECT id FROM users WHERE username = ?", args: [req.params.username] });
  if (!target.rows.length) return res.status(404).json({ error: "User not found" });
  const targetId = Number(target.rows[0].id);
  if (targetId === req.session.userId) return res.status(400).json({ error: "Can't vouch for yourself" });

  const existing = await db.execute({ sql: "SELECT id FROM vouches WHERE voucher_id = ? AND vouched_id = ?", args: [req.session.userId, targetId] });
  if (existing.rows.length) return res.status(409).json({ error: "Already vouched for this user" });

  await db.execute({
    sql: "INSERT INTO vouches (voucher_id, vouched_id, type, comment) VALUES (?, ?, ?, ?)",
    args: [req.session.userId, targetId, type, (comment || "").slice(0, 300)],
  });
  res.json({ ok: true });
});

// ── Blocks ──

app.post("/api/users/:username/block", auth, async (req, res) => {
  const target = await db.execute({ sql: "SELECT id FROM users WHERE username = ?", args: [req.params.username] });
  if (!target.rows.length) return res.status(404).json({ error: "User not found" });
  const targetId = Number(target.rows[0].id);
  if (targetId === req.session.userId) return res.status(400).json({ error: "Can't block yourself" });

  const existing = await db.execute({ sql: "SELECT id FROM blocks WHERE blocker_id = ? AND blocked_id = ?", args: [req.session.userId, targetId] });
  if (existing.rows.length) return res.status(409).json({ error: "Already blocked" });

  await db.execute({ sql: "INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)", args: [req.session.userId, targetId] });
  res.json({ ok: true });
});

app.delete("/api/users/:username/block", auth, async (req, res) => {
  const target = await db.execute({ sql: "SELECT id FROM users WHERE username = ?", args: [req.params.username] });
  if (!target.rows.length) return res.status(404).json({ error: "User not found" });
  await db.execute({ sql: "DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", args: [req.session.userId, Number(target.rows[0].id)] });
  res.json({ ok: true });
});

app.get("/api/my-blocks", auth, async (req, res) => {
  const r = await db.execute({ sql: "SELECT users.username FROM blocks JOIN users ON blocks.blocked_id = users.id WHERE blocks.blocker_id = ?", args: [req.session.userId] });
  res.json(r.rows.map(r => r.username));
});

// ── Scam Reports ──

app.post("/api/report", auth, muteCheck, async (req, res) => {
  const { reported_username, trade_id, reason, evidence_url, evidence_image } = req.body;
  if (!reported_username || !reason) return res.status(400).json({ error: "Username and reason required" });

  const target = await db.execute({ sql: "SELECT id FROM users WHERE username = ?", args: [reported_username] });
  if (!target.rows.length) return res.status(404).json({ error: "User not found" });
  const targetId = Number(target.rows[0].id);
  if (targetId === req.session.userId) return res.status(400).json({ error: "Can't report yourself" });

  const imgData = evidence_image && evidence_image.length < 500000 ? evidence_image : null;
  await db.execute({
    sql: "INSERT INTO scam_reports (reporter_id, reported_id, trade_id, reason, evidence_url, evidence_image) VALUES (?, ?, ?, ?, ?, ?)",
    args: [req.session.userId, targetId, trade_id || null, reason.slice(0, 1000), evidence_url || null, imgData],
  });

  const reportCount = await db.execute({ sql: "SELECT COUNT(DISTINCT reporter_id) as cnt FROM scam_reports WHERE reported_id = ?", args: [targetId] });
  if (Number(reportCount.rows[0].cnt) >= 3) {
    const muteUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19);
    await db.execute({ sql: "UPDATE users SET muted_until = ? WHERE id = ?", args: [muteUntil, targetId] });
  }
  res.json({ ok: true });
});

app.get("/api/users/:username/reports", async (req, res) => {
  const target = await db.execute({ sql: "SELECT id FROM users WHERE username = ?", args: [req.params.username] });
  if (!target.rows.length) return res.status(404).json({ error: "User not found" });
  const r = await db.execute({ sql: `SELECT scam_reports.*, users.username AS reporter_name FROM scam_reports JOIN users ON scam_reports.reporter_id = users.id WHERE scam_reports.reported_id = ? ORDER BY scam_reports.created_at DESC`, args: [target.rows[0].id] });
  res.json(r.rows);
});

// ── Presets ──

app.get("/api/presets", (_req, res) => {
  res.json({
    seeds: [
      { name: "Common Seed", rarity: "common", emoji: "🌱" },
      { name: "Uncommon Seed", rarity: "uncommon", emoji: "🌱" },
      { name: "Rare Seed", rarity: "rare", emoji: "🌱" },
      { name: "Legendary Seed", rarity: "legendary", emoji: "🌱" },
      { name: "Mythical Seed", rarity: "mythical", emoji: "🌱" },
      { name: "Godly Seed", rarity: "godly", emoji: "🌱" },
      { name: "Prismatic Seed", rarity: "prismatic", emoji: "🌱" },
      { name: "Chromatic Seed", rarity: "chromatic", emoji: "🌱" },
      { name: "Night Seed", rarity: "rare", emoji: "🌑" },
      { name: "Clover Seed", rarity: "legendary", emoji: "🍀" },
      { name: "Galaxy Seed", rarity: "mythical", emoji: "🌌" },
      { name: "Candy Seed", rarity: "legendary", emoji: "🍬" },
      { name: "Haunted Seed", rarity: "mythical", emoji: "👻" },
      { name: "Inferno Seed", rarity: "godly", emoji: "🔥" },
      { name: "Frost Seed", rarity: "godly", emoji: "❄️" },
      { name: "Gear Seed", rarity: "rare", emoji: "⚙️" },
    ],
    plants: [
      { name: "Daisy", rarity: "common", emoji: "🌼" },
      { name: "Tulip", rarity: "common", emoji: "🌷" },
      { name: "Rose", rarity: "uncommon", emoji: "🌹" },
      { name: "Sunflower", rarity: "uncommon", emoji: "🌻" },
      { name: "Lily", rarity: "rare", emoji: "💮" },
      { name: "Orchid", rarity: "rare", emoji: "🪻" },
      { name: "Venus Flytrap", rarity: "legendary", emoji: "🪴" },
      { name: "Bonsai", rarity: "legendary", emoji: "🌳" },
      { name: "Crystal Flower", rarity: "mythical", emoji: "💎" },
      { name: "Moonflower", rarity: "mythical", emoji: "🌙" },
      { name: "Dragon Fruit Plant", rarity: "godly", emoji: "🐉" },
      { name: "Aurora Blossom", rarity: "godly", emoji: "✨" },
      { name: "Void Bloom", rarity: "prismatic", emoji: "🖤" },
      { name: "Rainbow Rose", rarity: "chromatic", emoji: "🌈" },
    ],
    gear: [
      { name: "Basic Watering Can", rarity: "common", emoji: "🚿" },
      { name: "Silver Watering Can", rarity: "uncommon", emoji: "🚿" },
      { name: "Golden Watering Can", rarity: "rare", emoji: "🚿" },
      { name: "Diamond Watering Can", rarity: "legendary", emoji: "💎" },
      { name: "Basic Trowel", rarity: "common", emoji: "🔧" },
      { name: "Golden Trowel", rarity: "rare", emoji: "🔧" },
      { name: "Favorite Tool", rarity: "legendary", emoji: "⭐" },
      { name: "Sprinkler", rarity: "rare", emoji: "💦" },
      { name: "Auto Sprinkler", rarity: "legendary", emoji: "💦" },
      { name: "Fertilizer", rarity: "uncommon", emoji: "💊" },
      { name: "Super Fertilizer", rarity: "rare", emoji: "💊" },
      { name: "Mega Fertilizer", rarity: "legendary", emoji: "💊" },
    ],
    pets: [
      { name: "Ladybug", rarity: "common", emoji: "🐞" },
      { name: "Butterfly", rarity: "uncommon", emoji: "🦋" },
      { name: "Bee", rarity: "uncommon", emoji: "🐝" },
      { name: "Frog", rarity: "rare", emoji: "🐸" },
      { name: "Bunny", rarity: "rare", emoji: "🐰" },
      { name: "Fox", rarity: "legendary", emoji: "🦊" },
      { name: "Owl", rarity: "legendary", emoji: "🦉" },
      { name: "Phoenix", rarity: "mythical", emoji: "🔥" },
      { name: "Dragon", rarity: "godly", emoji: "🐲" },
      { name: "Unicorn", rarity: "mythical", emoji: "🦄" },
      { name: "Cosmic Cat", rarity: "prismatic", emoji: "🐱" },
    ],
  });
});

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Trade server running on http://localhost:${PORT}`));
});
