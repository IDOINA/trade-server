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
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      offering TEXT NOT NULL,
      wanting TEXT NOT NULL,
      details TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
  })
);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
  next();
}

// --- Auth routes ---

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: "Username must be 3-20 characters" });
  if (password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters" });

  const existing = await db.execute({ sql: "SELECT id FROM users WHERE username = ?", args: [username] });
  if (existing.rows.length) return res.status(409).json({ error: "Username taken" });

  const salt = crypto.randomBytes(16).toString("hex");
  const password_hash = hashPassword(password, salt);
  const result = await db.execute({ sql: "INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)", args: [username, password_hash, salt] });

  req.session.userId = Number(result.lastInsertRowid);
  req.session.username = username;
  res.json({ username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });

  const result = await db.execute({ sql: "SELECT * FROM users WHERE username = ?", args: [username] });
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const hash = hashPassword(password, user.salt);
  if (hash !== user.password_hash) return res.status(401).json({ error: "Invalid credentials" });

  req.session.userId = Number(user.id);
  req.session.username = user.username;
  res.json({ username: user.username });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: { username: req.session.username } });
});

// --- Trade routes ---

app.get("/api/trades", async (_req, res) => {
  const result = await db.execute(`
    SELECT trades.*, users.username
    FROM trades JOIN users ON trades.user_id = users.id
    ORDER BY trades.created_at DESC
  `);
  res.json(result.rows);
});

app.post("/api/trades", requireAuth, async (req, res) => {
  const { offering, wanting, details } = req.body;
  if (!offering || !wanting) return res.status(400).json({ error: "Offering and wanting fields required" });

  const result = await db.execute({
    sql: "INSERT INTO trades (user_id, offering, wanting, details) VALUES (?, ?, ?, ?)",
    args: [req.session.userId, offering.slice(0, 200), wanting.slice(0, 200), (details || "").slice(0, 500)],
  });

  const trade = await db.execute({
    sql: "SELECT trades.*, users.username FROM trades JOIN users ON trades.user_id = users.id WHERE trades.id = ?",
    args: [result.lastInsertRowid],
  });
  res.json(trade.rows[0]);
});

app.patch("/api/trades/:id", requireAuth, async (req, res) => {
  const result = await db.execute({ sql: "SELECT * FROM trades WHERE id = ?", args: [req.params.id] });
  const trade = result.rows[0];
  if (!trade) return res.status(404).json({ error: "Trade not found" });
  if (Number(trade.user_id) !== req.session.userId) return res.status(403).json({ error: "Not your trade" });

  const { status } = req.body;
  if (!["open", "closed", "completed"].includes(status)) return res.status(400).json({ error: "Invalid status" });

  await db.execute({ sql: "UPDATE trades SET status = ? WHERE id = ?", args: [status, req.params.id] });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => console.log(`Trade server running on http://localhost:${PORT}`));
});
