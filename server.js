"use strict";
/* ميزان الوفاق الزوجي — standalone server for Railway.
   Serves the app and keeps each couple's shared data in its own database.
   Storage: PostgreSQL when DATABASE_URL is set (recommended), otherwise a JSON file in DATA_DIR. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

/* ---------- storage ---------- */
function fileStore() {
  const dir = process.env.DATA_DIR || path.join(ROOT, "data");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wifaq-db.json");
  let m = new Map();
  try { m = new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))); } catch (e) {}
  let t = null;
  const flush = () => {
    t = null;
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)));
    fs.renameSync(tmp, file);
  };
  const save = () => { if (!t) t = setTimeout(flush, 300); };
  process.on("SIGTERM", () => { if (t) { clearTimeout(t); flush(); } process.exit(0); });
  return {
    kind: "file",
    async init() {},
    async get(p) { return m.get(p) || null; },
    async put(p, data) { const r = { data, updated: Date.now() }; m.set(p, r); save(); return r; },
    async merge(p, patch) { const old = m.get(p); const r = { data: { ...(old ? old.data : {}), ...patch }, updated: Date.now() }; m.set(p, r); save(); return r; },
    async create(p, data) { if (m.has(p)) return false; m.set(p, { data, updated: Date.now() }); save(); return true; },
    async del(p) { m.delete(p); save(); },
    async prefix(pre) { const out = []; for (const [p, r] of m) if (p.startsWith(pre)) out.push({ path: p, ...r }); return out; },
  };
}

function pgStore(url) {
  const { Pool } = require("pg");
  const ssl = /sslmode=require/.test(url) || process.env.PGSSL === "1" ? { rejectUnauthorized: false } : false;
  const pool = new Pool({ connectionString: url, ssl, max: 5 });
  const row = r => ({ data: r.data, updated: Number(r.updated) });
  return {
    kind: "postgres",
    async init() {
      await pool.query("CREATE TABLE IF NOT EXISTS wifaq_docs (path TEXT PRIMARY KEY, data JSONB NOT NULL, updated BIGINT NOT NULL)");
    },
    async get(p) {
      const r = await pool.query("SELECT data, updated FROM wifaq_docs WHERE path = $1", [p]);
      return r.rows[0] ? row(r.rows[0]) : null;
    },
    async put(p, data) {
      const u = Date.now();
      await pool.query(
        "INSERT INTO wifaq_docs (path, data, updated) VALUES ($1, $2, $3) ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated = EXCLUDED.updated",
        [p, JSON.stringify(data), u]);
      return { data, updated: u };
    },
    async merge(p, patch) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const r = await c.query("SELECT data FROM wifaq_docs WHERE path = $1 FOR UPDATE", [p]);
        const data = { ...(r.rows[0] ? r.rows[0].data : {}), ...patch };
        const u = Date.now();
        await c.query(
          "INSERT INTO wifaq_docs (path, data, updated) VALUES ($1, $2, $3) ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated = EXCLUDED.updated",
          [p, JSON.stringify(data), u]);
        await c.query("COMMIT");
        return { data, updated: u };
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    async create(p, data) {
      const ex = await pool.query("SELECT 1 FROM wifaq_docs WHERE path = $1", [p]);
      if (ex.rows.length) return false;
      const r = await pool.query(
        "INSERT INTO wifaq_docs (path, data, updated) VALUES ($1, $2, $3) ON CONFLICT (path) DO NOTHING RETURNING path",
        [p, JSON.stringify(data), Date.now()]);
      return r.rows.length === 1;
    },
    async del(p) { await pool.query("DELETE FROM wifaq_docs WHERE path = $1", [p]); },
    async prefix(pre) {
      const like = pre.replace(/[\\%_]/g, "\\$&") + "%";
      const r = await pool.query("SELECT path, data, updated FROM wifaq_docs WHERE path LIKE $1", [like]);
      return r.rows.map(x => ({ path: x.path, ...row(x) }));
    },
  };
}

const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore();

/* ---------- helpers ---------- */
const MAX_BODY = 1024 * 1024;
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const CODE = /^(p\d{7,15}|[a-z0-9][a-z0-9-]{2,23})$/;
const ROLES = new Set(["h", "w"]);
const ROLE_NAME = { h: "الزوج", w: "الزوجة" };

function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(Object.assign(new Error("bad json"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
function scrypt(pin, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(String(pin), salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? reject(e) : resolve(k)));
}
const clientIp = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

/* failed-login limiter: 8 per account and 30 per address in 15 minutes */
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
function blocked(key, max) { const f = fails.get(key); return f && f.until > Date.now() && f.n >= max; }
function fail(key) { const f = fails.get(key); if (!f || f.until < Date.now()) fails.set(key, { n: 1, until: Date.now() + WINDOW }); else f.n++; }
setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (f.until < now) fails.delete(k); }, 60 * 1000).unref();

/* sessions */
const sessCache = new Map();
async function session(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const tok = m[1];
  const c = sessCache.get(tok);
  if (c && c.at > Date.now() - 60 * 1000) return c.s;
  const r = await store.get("_sess/" + tok);
  const s = r ? r.data : null;
  sessCache.set(tok, { s, at: Date.now() });
  return s;
}
function checkPath(p, sess, kind) {
  if (typeof p !== "string" || p.length > 600) return false;
  const parts = p.split("/");
  if (parts.length < 3 || parts.length > 8 || !parts.every(s => SEG.test(s))) return false;
  if (parts[0] !== "couples" || parts[1] !== sess.code) return false;
  return kind === "doc" ? parts.length % 2 === 0 : parts.length % 2 === 1;
}

/* ---------- API ---------- */
async function handleApi(req, res, url) {
  const route = req.method + " " + url.pathname;

  if (route === "GET /api/health") return send(res, 200, { ok: true, storage: store.kind });

  if (route === "POST /api/auth/register" || route === "POST /api/auth/login") {
    const b = await readBody(req);
    const code = String(b.code || "").toLowerCase(), pin = String(b.pin || ""), role = String(b.role || "");
    const name = String(b.name || "").trim().slice(0, 60), device = String(b.device || "").slice(0, 60);
    if (!CODE.test(code)) return send(res, 400, { error: "رقم الهاتف غير صحيح." });
    if (!ROLES.has(role)) return send(res, 400, { error: "اختر بجانب الرقم: زوج أو زوجة." });
    if (!/^\d{4,6}$/.test(pin)) return send(res, 400, { error: "رمز الدخول من 4 إلى 6 أرقام." });
    const ip = clientIp(req);
    const authPath = "_auth/" + code, metaPath = `couples/${code}/meta/info`;

    if (route.endsWith("register")) {
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = (await scrypt(pin, salt)).toString("hex");
      const made = await store.create(authPath, { salt, hash, created: Date.now() });
      if (!made) return send(res, 409, { error: "يوجد حساب بهذا الرقم. اختر «تسجيل الدخول»." });
      const meta = { [role]: device, ["name_" + role]: name || ROLE_NAME[role], created: Date.now() };
      if (code.startsWith("p")) meta.phone = "+" + code.slice(1);
      await store.merge(metaPath, meta);
    } else {
      if (blocked("c:" + code, 8) || blocked("i:" + ip, 30)) return send(res, 429, { error: "محاولات كثيرة غير صحيحة. انتظر 15 دقيقة ثم حاول مرة أخرى." });
      const a = await store.get(authPath);
      if (!a) { fail("i:" + ip); return send(res, 404, { error: "لا يوجد حساب بهذا الرقم. اختر «مستخدم جديد» لإنشائه." }); }
      const hash = await scrypt(pin, a.data.salt);
      if (!crypto.timingSafeEqual(hash, Buffer.from(a.data.hash, "hex"))) {
        fail("c:" + code); fail("i:" + ip);
        return send(res, 401, { error: "رمز الدخول غير صحيح." });
      }
      const m = await store.get(metaPath);
      const patch = { [role]: device };
      if (name || !(m && m.data["name_" + role])) patch["name_" + role] = name || ROLE_NAME[role];
      await store.merge(metaPath, patch);
    }
    const token = crypto.randomBytes(24).toString("base64url");
    await store.put("_sess/" + token, { code, role, created: Date.now() });
    return send(res, 200, { token, code, role });
  }

  const sess = await session(req);
  if (!sess) return send(res, 401, { error: "انتهت الجلسة. سجّل الدخول من جديد.", code: "not_granted" });

  if (route === "POST /api/auth/logout") {
    const tok = (req.headers.authorization || "").slice(7);
    sessCache.delete(tok); await store.del("_sess/" + tok);
    return send(res, 200, { ok: true });
  }

  if (route === "GET /api/all") {
    const rows = await store.prefix(`couples/${sess.code}/`);
    rows.sort((a, b) => a.path < b.path ? -1 : 1);
    const v = crypto.createHash("sha1").update(rows.map(r => r.path + ":" + r.updated).join("|")).digest("hex").slice(0, 16);
    if (url.searchParams.get("since") === v) return send(res, 200, { same: true, v });
    return send(res, 200, { v, docs: rows.map(r => ({ path: r.path, data: r.data })) });
  }

  if (url.pathname === "/api/doc") {
    if (req.method === "GET" || req.method === "DELETE") {
      const p = url.searchParams.get("path");
      if (!checkPath(p, sess, "doc")) return send(res, 403, { error: "غير مسموح." });
      if (req.method === "DELETE") { await store.del(p); return send(res, 200, { ok: true }); }
      const r = await store.get(p);
      return send(res, 200, r ? { exists: true, data: r.data } : { exists: false });
    }
    if (req.method === "PUT") {
      const b = await readBody(req);
      if (!checkPath(b.path, sess, "doc") || !isObj(b.data)) return send(res, 403, { error: "غير مسموح." });
      if (JSON.stringify(b.data).length > 200000) return send(res, 413, { error: "البيانات كبيرة جداً." });
      const r = b.merge ? await store.merge(b.path, b.data) : await store.put(b.path, b.data);
      return send(res, 200, { ok: true, data: r.data });
    }
  }

  if (route === "POST /api/col") {
    const b = await readBody(req);
    if (!checkPath(b.path, sess, "col") || !isObj(b.data)) return send(res, 403, { error: "غير مسموح." });
    if (JSON.stringify(b.data).length > 200000) return send(res, 413, { error: "البيانات كبيرة جداً." });
    const id = Date.now().toString(36) + crypto.randomBytes(5).toString("hex");
    await store.put(b.path + "/" + id, b.data);
    return send(res, 200, { id });
  }

  return send(res, 404, { error: "غير موجود." });
}

/* ---------- static files ---------- */
const STATIC = {
  "/": "index.html", "/index.html": "index.html", "/manifest.webmanifest": "manifest.webmanifest", "/sw.js": "sw.js",
  "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png", "/apple-touch-icon.png": "apple-touch-icon.png",
};
const TYPES = { ".html": "text/html; charset=utf-8", ".webmanifest": "application/manifest+json", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };
function serveStatic(req, res, url) {
  const f = STATIC[url.pathname];
  if (!f || (req.method !== "GET" && req.method !== "HEAD")) { res.writeHead(f ? 405 : 404, { "content-type": "text/plain; charset=utf-8" }); return res.end(f ? "Method not allowed" : "Not found"); }
  fs.readFile(path.join(ROOT, f), (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(f);
    res.writeHead(200, {
      "content-type": TYPES[ext] || "application/octet-stream",
      "cache-control": ext === ".png" ? "public, max-age=86400" : "no-cache",
      "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status === 413 ? "البيانات كبيرة جداً." : "خطأ في الخادم، حاول مرة أخرى." });
  }
});

store.init().then(() => {
  server.listen(PORT, () => console.log(`Wifaq is running on port ${PORT} (storage: ${store.kind})`));
}).catch(e => { console.error("Could not start storage:", e.message); process.exit(1); });
