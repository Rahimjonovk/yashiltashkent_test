"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const cfg = require("./env");
const store = require("./store");
const auth = require("./auth");
const svc = require("./service");
const geo = require("./geocode");
const bot = require("./bot");
const { E, HttpError } = auth;

/* ---------- helpers ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json" };

function clientIp(req) {
  if (cfg.TRUST_PROXY) { const x = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim(); if (x) return x; }
  return req.socket.remoteAddress || "?";
}
function corsOrigin(req) {
  const o = req.headers.origin;
  if (!o) return null;
  if (cfg.CORS_ORIGINS.indexOf(o) >= 0) return o;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o)) return o;   // local development (Live Server etc.)
  return null;
}
function send(req, res, status, body, headers) {
  const h = Object.assign({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" }, headers || {});
  const co = corsOrigin(req);
  if (co) { h["Access-Control-Allow-Origin"] = co; h["Vary"] = "Origin"; h["Access-Control-Expose-Headers"] = "Content-Disposition"; }
  if (typeof body === "string") body = Buffer.from(body);
  if (body.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && /json|text|javascript|svg/.test(h["Content-Type"] || "")) {
    body = zlib.gzipSync(body); h["Content-Encoding"] = "gzip"; h["Vary"] = (h["Vary"] ? h["Vary"] + ", " : "") + "Accept-Encoding";
  }
  h["Content-Length"] = body.length;
  res.writeHead(status, h);
  res.end(req.method === "HEAD" ? undefined : body);
}
const json = (req, res, status, obj, extra) => send(req, res, status, JSON.stringify(obj), Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, extra));
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > limit) { reject(E(413, "toolarge", "Soʻrov hajmi juda katta.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!n) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(E(400, "json", "Notoʻgʻri JSON.")); }
    });
    req.on("error", reject);
  });
}

/* ---------- SSE (live updates for web pages) ---------- */
const sse = new Set();
store.bus.on("change", ev => { const msg = "data: " + JSON.stringify(ev) + "\n\n"; sse.forEach(r => { try { r.write(msg); } catch (e) { sse.delete(r); } }); });
setInterval(() => sse.forEach(r => { try { r.write(": ping\n\n"); } catch (e) { sse.delete(r); } }), 25000).unref();
function stream(req, res) {
  const h = { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" };
  const co = corsOrigin(req); if (co) { h["Access-Control-Allow-Origin"] = co; h["Vary"] = "Origin"; }
  res.writeHead(200, h);
  res.write("retry: 3000\n\ndata: " + JSON.stringify({ v: store.db.version, kind: "hello" }) + "\n\n");
  sse.add(res);
  req.on("close", () => sse.delete(res));
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:[a-z]+/g, "([^/]+)") + "$"), fn });

const needUser = c => { if (!c.user) throw E(401, "auth", "Avval tizimga kiring."); return c.user; };
const needMod = c => { needUser(c); if (!svc.isMod(c.user)) throw E(403, "forbidden", "Bu amal faqat moderatorlar uchun."); return c.user; };
const needSuper = c => { needUser(c); if (!svc.isSuper(c.user)) throw E(403, "forbidden", "Bu amal faqat super admin uchun."); return c.user; };
const actorOf = u => ({ id: u.id, name: u.name, login: u.login, via: "web" });

route("GET", "/api/health", async c => ({ ok: true, version: store.db.version, uptime: Math.round(process.uptime()) }));
route("GET", "/api/config", async c => ({ botUsername: bot.status().username || "", botEnabled: bot.status().running, publicUrl: cfg.PUBLIC_URL, geocode: !cfg.GEO_DISABLED }));

route("GET", "/api/reports", async c => {
  const reports = svc.allReports().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5000).map(r => svc.view(r, c.user));
  return { version: store.db.version, reports, responses: store.db.responses };
});
route("GET", "/api/reports/:code/photo", async c => {
  const p = store.readPhoto(c.params[0]);
  if (!p) throw E(404, "notfound", "Rasm topilmadi.");
  c.raw = { status: 200, body: p.buf, headers: { "Content-Type": p.mime, "Cache-Control": "public, max-age=3600" } };
});
route("POST", "/api/reports", async c => {
  const ip = clientIp(c.req);
  auth.rate("rep:" + ip, c.user ? 40 : 15, 3600e3, "Juda koʻp murojaat yuborildi. Birozdan soʻng urinib koʻring.");
  const body = await readJson(c.req, 1.2 * 1024 * 1024);
  const photo = body.photo ? svc.decodePhoto(body.photo, 400 * 1024) : null;
  // district: trust the client, but fall back to what the geocoder found
  const rep = svc.createReport(body, { user: c.user, via: "web" }, photo);
  return { report: svc.view(rep, c.user) };
});
route("PUT", "/api/reports/:code/response", async c => {
  const u = needMod(c);
  const body = await readJson(c.req, 20 * 1024);
  return { response: svc.setResponse(c.params[0], body, actorOf(u)) };
});
route("DELETE", "/api/reports/:code", async c => { const u = needMod(c); svc.deleteReport(c.params[0], actorOf(u)); return { ok: true }; });

route("GET", "/api/geocode", async c => {
  auth.rate("geo:" + clientIp(c.req), 90, 60e3, "Manzil soʻrovlari juda koʻp. Biroz kuting.");
  return await geo.reverse(c.query.get("lat"), c.query.get("lon"));
});
route("GET", "/api/geocode/search", async c => {
  auth.rate("geo:" + clientIp(c.req), 90, 60e3, "Manzil soʻrovlari juda koʻp. Biroz kuting.");
  return { results: await geo.search(c.query.get("q")) };
});

/* auth */
route("POST", "/api/auth/register", async c => auth.register(await readJson(c.req, 10 * 1024), clientIp(c.req)));
route("POST", "/api/auth/login", async c => { const b = await readJson(c.req, 10 * 1024); return auth.login(b.login, b.password, clientIp(c.req)); });
route("POST", "/api/auth/logout", async c => { auth.destroySession(c.token); return { ok: true }; });
route("GET", "/api/auth/me", async c => ({ user: c.user ? auth.pub(c.user) : null }));
route("POST", "/api/auth/password", async c => {
  const u = needUser(c); const b = await readJson(c.req, 10 * 1024);
  await auth.changePassword(u, b.oldPassword, b.newPassword, c.token);
  return { ok: true };
});
route("POST", "/api/auth/telegram-link", async c => {
  const u = needUser(c);
  const st = bot.status();
  return { code: auth.newLinkCode(u), botUsername: st.username || "", botEnabled: st.running, expiresIn: 600 };
});
route("DELETE", "/api/auth/telegram-link", async c => { const u = needUser(c); svc.unlinkTelegramByUser(u); return { ok: true }; });

/* super admin */
route("GET", "/api/super/overview", async c => { needSuper(c); return svc.overview(); });
route("GET", "/api/super/users", async c => {
  needSuper(c);
  const counts = {}; svc.allReports().forEach(r => { if (r.authorId) counts[r.authorId] = (counts[r.authorId] || 0) + 1; });
  return { users: store.db.users.map(u => Object.assign(auth.pub(u), { reports: counts[u.id] || 0 })) };
});
route("POST", "/api/super/users", async c => {
  const a = needSuper(c); const b = await readJson(c.req, 10 * 1024);
  return { user: auth.pub(await svc.createByAdmin(actorOf(a), b)) };
});
route("PATCH", "/api/super/users/:id", async c => {
  const a = needSuper(c); const b = await readJson(c.req, 10 * 1024), id = c.params[0];
  if (b.role !== undefined) svc.setRole(a, id, b.role);
  if (b.blocked !== undefined) svc.setBlocked(a, id, !!b.blocked);
  if (b.unlinkTelegram) { const u = auth.findById(id); if (u) svc.unlinkTelegramByUser(u); }
  return { ok: true };
});
route("DELETE", "/api/super/users/:id", async c => { const a = needSuper(c); svc.removeUser(a, c.params[0]); return { ok: true }; });
route("POST", "/api/super/users/:id/password", async c => {
  const a = needSuper(c); const b = await readJson(c.req, 10 * 1024);
  await svc.resetPassword(a, c.params[0], b.password); return { ok: true };
});
route("GET", "/api/super/tgusers", async c => {
  needSuper(c);
  return { users: Object.values(store.db.tgUsers).sort((a, b) => b.createdAt - a.createdAt).map(t => {
    const u = t.userId && auth.findById(t.userId);
    return { id: t.id, name: t.name, username: t.username, phone: t.phone || "", linked: u ? u.login : "", role: u ? u.role : "", notifyNew: !!t.notifyNew, blocked: !!t.blocked, createdAt: t.createdAt };
  }) };
});
route("PATCH", "/api/super/tgusers/:id", async c => {
  const a = needSuper(c); const b = await readJson(c.req, 2 * 1024);
  const t = store.db.tgUsers[c.params[0]]; if (!t) throw E(404, "notfound", "Telegram foydalanuvchisi topilmadi.");
  if (b.blocked !== undefined) { t.blocked = !!b.blocked; svc.audit(a, t.blocked ? "tg.block" : "tg.unblock", "@" + (t.username || t.id)); }
  if (b.notifyNew !== undefined) t.notifyNew = !!b.notifyNew;
  store.bump("tg"); return { ok: true };
});
route("GET", "/api/super/audit", async c => { needSuper(c); return { items: store.db.audit.slice(-500).reverse() }; });
route("GET", "/api/super/settings", async c => { needSuper(c); return { settings: store.db.settings, bot: bot.status(), publicUrl: cfg.PUBLIC_URL }; });
route("PUT", "/api/super/settings", async c => { const a = needSuper(c); return { settings: svc.setSettings(a, await readJson(c.req, 4 * 1024)) }; });
route("POST", "/api/super/bot/test", async c => { needSuper(c); return await bot.testNotify(); });
route("POST", "/api/super/import", async c => { const a = needSuper(c); return svc.importLegacy(a, await readJson(c.req, 40 * 1024 * 1024)); });
route("GET", "/api/super/export", async c => {
  needSuper(c);
  const d = store.db;
  const out = { exportedAt: new Date().toISOString(), reports: Object.values(d.reports), responses: d.responses,
    users: d.users.map(auth.pub), tgUsers: d.tgUsers, settings: d.settings, audit: d.audit };
  c.raw = { status: 200, body: Buffer.from(JSON.stringify(out, null, 1)), headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="yashil-toshkent-backup-' + new Date().toISOString().slice(0, 10) + '.json"', "Cache-Control": "no-store" } };
});

/* ---------- static files ---------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(cfg.PUBLIC_DIR, rel));
  if (file.indexOf(cfg.PUBLIC_DIR + path.sep) !== 0 || /(^|[\\/])\./.test(path.relative(cfg.PUBLIC_DIR, file))) return json(req, res, 404, { error: { code: "notfound", message: "Topilmadi." } });
  fs.readFile(file, (err, buf) => {
    if (err) return json(req, res, 404, { error: { code: "notfound", message: "Sahifa topilmadi." } });
    const ext = path.extname(file).toLowerCase();
    send(req, res, 200, buf, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300" });
  });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch (e) { res.writeHead(400); return res.end(); }
  const pathname = url.pathname;
  try {
    if (req.method === "OPTIONS") {
      const co = corsOrigin(req);
      res.writeHead(204, co ? { "Access-Control-Allow-Origin": co, "Vary": "Origin", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600" } : {});
      return res.end();
    }
    if (!pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, pathname);
    }
    if (pathname === "/api/stream" && req.method === "GET") return stream(req, res);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const token = auth.tokenOf(req);
      const c = { req, res, query: url.searchParams, params: m.slice(1).map(decodeURIComponent), token, user: auth.userFromToken(token), raw: null };
      const out = await r.fn(c);
      if (c.raw) return send(req, res, c.raw.status, c.raw.body, c.raw.headers);
      return json(req, res, 200, out);
    }
    json(req, res, 404, { error: { code: "notfound", message: "Soʻralgan manzil topilmadi." } });
  } catch (e) {
    if (e instanceof HttpError) {
      const extra = e.seconds ? { "Retry-After": String(e.seconds) } : {};
      return json(req, res, e.status, { error: { code: e.code, message: e.message } }, extra);
    }
    if (e && e.code === "photo") return json(req, res, 400, { error: { code: "photo", message: e.message } });
    console.error("[http]", req.method, pathname, e && e.stack || e);
    json(req, res, 500, { error: { code: "server", message: "Server xatosi. Keyinroq urinib koʻring." } });
  }
});
server.requestTimeout = 60000;

(async () => {
  const seeded = await auth.seedSuperadmin();
  if (seeded) {
    store.flushSync();
    const line = "=".repeat(64);
    console.log("\n" + line + "\n  SUPER ADMIN hisobi yaratildi\n  login:  " + seeded.login + "\n  parol:  " + seeded.password +
      (seeded.generated ? "\n  (parol tasodifiy yaratildi — birinchi kirishda oʻzgartiring)" : "\n  (parol .env faylidan olindi)") + "\n" + line + "\n");
  }
  server.listen(cfg.PORT, cfg.HOST, () => {
    console.log("Yashil Toshkent: http://localhost:" + cfg.PORT + "   (maʼlumotlar: " + cfg.DATA_DIR + ")");
    bot.start();
  });
})();
