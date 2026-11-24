"use strict";
/* Business logic shared by the web API and the Telegram bot, so both behave identically. */
const crypto = require("crypto");
const store = require("./store");
const auth = require("./auth");
const C = require("./constants");
const { E } = auth;

const isMod = u => !!u && !u.blocked && (u.role === "admin" || u.role === "superadmin");
const isSuper = u => !!u && !u.blocked && u.role === "superadmin";

/* ---------- audit ---------- */
function audit(actor, action, target, detail) {
  const a = store.db.audit;
  a.push({ ts: Date.now(), actor: actor && actor.id || "", actorName: actor && (actor.name || actor.login) || "system", action, target: target || "", detail: detail || "" });
  if (a.length > 3000) a.splice(0, a.length - 3000);
  store.save();
}

/* ---------- reports ---------- */
const clip = (s, n) => String(s == null ? "" : s).trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n);

function genCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let tries = 0; tries < 20; tries++) {
    const b = crypto.randomBytes(6);
    let s = "";
    for (let i = 0; i < 6; i++) s += A[b[i] % A.length];
    const code = "TD-" + s;
    if (!store.db.reports[code]) return code;
  }
  throw E(500, "code", "Raqam yaratib boʻlmadi. Qayta urinib koʻring.");
}

function decodePhoto(dataUrl, maxBytes) {
  if (!dataUrl) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl));
  if (!m) throw E(400, "photo", "Rasm formati notoʻgʻri.");
  const buf = Buffer.from(m[2].replace(/\s/g, ""), "base64");
  if (buf.length > (maxBytes || 600 * 1024)) throw E(400, "photo", "Rasm juda katta.");
  return buf;
}

/* input: raw fields; ctx: {user, tgUser, via}; photo: Buffer|null */
function createReport(input, ctx, photo) {
  input = input || {}; ctx = ctx || {};
  const type = String(input.type || "");
  if (!C.TYPES[type]) throw E(400, "type", "Muammo turini tanlang.");
  const tree = C.TYPES[type].tree;
  let species = null, count = null;
  if (tree) {
    species = clip(input.species, 40);
    if (species.length < 2) throw E(400, "species", "Daraxt turini tanlang.");
    count = String(input.count || "");
    if (!C.COUNTS[count]) throw E(400, "count", "Daraxtlar sonini tanlang.");
  }
  const lat = Number(input.lat), lon = Number(input.lon);
  if (!isFinite(lat) || !isFinite(lon)) throw E(400, "loc", "Joylashuvni belgilang.");
  if (!C.inPlace(lat, lon)) throw E(400, "loc", "Bu nuqta Toshkent hududidan tashqarida.");
  let district = String(input.district || "");
  if (C.DISTRICTS.indexOf(district) < 0) district = C.nearestDistrict(lat, lon);   // never ask: detect from the point
  const description = clip(input.description, 600);
  if (description.length < 10) throw E(400, "desc", "Kamida 10 ta belgi yozing: nima, qayerda, qachondan beri.");
  const via = ctx.via === "telegram" ? "telegram" : "web";
  const source = ["gps", "map", "telegram", "search"].indexOf(input.source) >= 0 ? input.source : "map";
  const acc = Number(input.accuracy);

  let authorId = null, tgId = null, name = clip(input.name, 40);
  if (ctx.user) { authorId = ctx.user.id; if (!name) name = ctx.user.name; if (ctx.user.telegramId) tgId = String(ctx.user.telegramId); }
  if (ctx.tgUser) {
    tgId = String(ctx.tgUser.id);
    if (!authorId) authorId = ctx.tgUser.userId || "tg:" + ctx.tgUser.id;
    if (!name) name = ctx.tgUser.name || "";
  }
  const code = genCode();
  const rep = {
    code, type, species, count,
    danger: !!input.danger,
    active: type === "kesish" && !!input.active,
    lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)),
    accuracy: isFinite(acc) && acc > 0 ? Math.round(acc) : null, source,
    district, landmark: clip(input.landmark, 100), address: clip(input.address, 220),
    description, name, authorId, tgId, via,
    phone: ctx.tgUser && ctx.tgUser.phone || "",   // private: shown to staff only (see view)
    createdAt: Date.now(), hasPhoto: false
  };
  if (photo) { store.savePhoto(code, photo); rep.hasPhoto = true; }
  store.db.reports[code] = rep;
  audit(ctx.user || { name: name || "Fuqaro" }, "report.create", code, via + " · " + type + " · " + district);
  store.bump("report");
  store.bus.emit("report:new", rep);
  return rep;
}

function view(r, viewer) {
  const mod = isMod(viewer);
  const o = {
    code: r.code, type: r.type, species: r.species, count: r.count, danger: !!r.danger, active: !!r.active,
    lat: r.lat, lon: r.lon, accuracy: r.accuracy, source: r.source, district: r.district, landmark: r.landmark || "",
    address: r.address || "", description: r.description, name: r.name || "", createdAt: r.createdAt, hasPhoto: !!r.hasPhoto,
    via: r.via || "web", mine: !!(viewer && r.authorId && r.authorId === viewer.id)
  };
  if (mod) {
    const au = r.authorId && store.db.users.find(u => u.id === r.authorId);
    o.authorLogin = au ? au.login : "";
    const tu = r.tgId && store.db.tgUsers[r.tgId];
    o.tgUsername = tu && tu.username ? tu.username : "";
    o.phone = r.phone || (tu && tu.phone) || "";
  }
  return o;
}

function setResponse(code, input, actor) {
  const rep = store.db.reports[code];
  if (!rep) throw E(404, "notfound", "Murojaat topilmadi. U oʻchirilgan boʻlishi mumkin.");
  const status = String(input.status || "");
  if (!C.STATUS[status]) throw E(400, "status", "Holatni tanlang.");
  const org = clip(input.org, 80), text = clip(input.text, 800);
  if ((status === "hal" || status === "rad") && text.length < 5) throw E(400, "text", "Javob matnini yozing (kamida 5 ta belgi).");
  const prev = store.db.responses[code] || null;
  const doc = { status, org, text, createdAt: prev && prev.createdAt || Date.now(), updatedAt: Date.now(), by: clip(actor && (actor.name || actor.login), 40) };
  store.db.responses[code] = doc;
  audit(actor, "response.set", code, status + (actor && actor.via ? " · " + actor.via : ""));
  store.bump("response");
  store.bus.emit("response", { report: rep, response: doc, prev, actor });
  return doc;
}

function deleteReport(code, actor) {
  const rep = store.db.reports[code];
  if (!rep) throw E(404, "notfound", "Murojaat topilmadi.");
  delete store.db.reports[code]; delete store.db.responses[code]; store.removePhoto(code);
  audit(actor, "report.delete", code, rep.type + " · " + rep.district);
  store.bump("report");
  store.bus.emit("report:deleted", rep);
}

function statusOf(code) { const r = store.db.responses[code]; return r && C.STATUS[r.status] ? r.status : "yangi"; }
const isOpen = code => { const s = statusOf(code); return s !== "hal" && s !== "rad"; };
const isUrgent = r => !!(r.danger || r.active);
const allReports = () => Object.values(store.db.reports);

/* ---------- stats ---------- */
function overview() {
  const reps = allReports(), now = Date.now(), DAY = 86400e3;
  const byStatus = { yangi: 0, korib: 0, hal: 0, rad: 0 }, byType = {}, byDistrict = {}, byVia = { web: 0, telegram: 0 };
  let urgent = 0, today = 0, week = 0, respMs = 0, respN = 0;
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(startToday.getTime() - i * DAY); days.push({ t: d.getTime(), n: 0 }); }
  reps.forEach(r => {
    const st = statusOf(r.code); byStatus[st]++;
    byType[r.type] = (byType[r.type] || 0) + 1;
    byDistrict[r.district] = (byDistrict[r.district] || 0) + 1;
    byVia[r.via === "telegram" ? "telegram" : "web"]++;
    if (isUrgent(r) && isOpen(r.code)) urgent++;
    if (r.createdAt >= startToday.getTime()) today++;
    if (r.createdAt >= now - 7 * DAY) week++;
    const resp = store.db.responses[r.code];
    if (resp && resp.createdAt && resp.createdAt >= r.createdAt) { respMs += resp.createdAt - r.createdAt; respN++; }
    for (let i = days.length - 1; i >= 0; i--) if (r.createdAt >= days[i].t) { days[i].n++; break; }
  });
  const users = store.db.users;
  const tg = Object.values(store.db.tgUsers);
  return {
    reports: reps.length, open: reps.filter(r => isOpen(r.code)).length, urgent, today, week,
    byStatus, byType, byDistrict, byVia, days,
    avgResponseHours: respN ? Math.round(respMs / respN / 36e5 * 10) / 10 : null,
    users: users.filter(u => u.role === "user").length,
    admins: users.filter(u => u.role === "admin").length,
    supers: users.filter(u => u.role === "superadmin").length,
    blocked: users.filter(u => u.blocked).length,
    tgUsers: tg.length, tgLinked: tg.filter(t => t.userId).length
  };
}

/* ---------- user management (super admin) ---------- */
function guardSupers(mutator) {
  const before = auth.activeSupers().length;
  mutator();
  if (before >= 1 && auth.activeSupers().length < 1) throw E(400, "lastsuper", "Kamida bitta faol super admin qolishi kerak.");
}
function mustUser(id) { const u = auth.findById(id); if (!u) throw E(404, "notfound", "Foydalanuvchi topilmadi."); return u; }

function setRole(actor, id, role) {
  if (C.ROLES.indexOf(role) < 0) throw E(400, "role", "Notoʻgʻri rol.");
  const u = mustUser(id);
  if (u.id === actor.id && role !== u.role) throw E(400, "self", "Oʻz rolingizni oʻzgartira olmaysiz.");
  const old = u.role;
  const snapshot = u.role;
  try { guardSupers(() => { u.role = role; }); } catch (e) { u.role = snapshot; throw e; }
  audit(actor, "user.role", u.login, old + " → " + role);
  store.bump("users");
}
function setBlocked(actor, id, blocked) {
  const u = mustUser(id);
  if (u.id === actor.id && blocked) throw E(400, "self", "Oʻzingizni bloklay olmaysiz.");
  const old = !!u.blocked;
  try { guardSupers(() => { u.blocked = !!blocked; }); } catch (e) { u.blocked = old; throw e; }
  if (blocked) auth.destroyUserSessions(u.id);
  audit(actor, blocked ? "user.block" : "user.unblock", u.login);
  store.bump("users");
}
function removeUser(actor, id) {
  const u = mustUser(id);
  if (u.id === actor.id) throw E(400, "self", "Oʻz hisobingizni oʻchira olmaysiz.");
  const list = store.db.users, i = list.indexOf(u);
  try { guardSupers(() => { list.splice(i, 1); }); } catch (e) { list.splice(i, 0, u); throw e; }
  auth.destroyUserSessions(u.id);
  Object.values(store.db.tgUsers).forEach(t => { if (t.userId === u.id) t.userId = null; });
  audit(actor, "user.delete", u.login);
  store.bump("users");
}
async function createByAdmin(actor, o) {
  const u = await auth.createUser({ name: o.name, login: o.login, password: o.password, role: C.ROLES.indexOf(o.role) >= 0 ? o.role : "user", mustChange: true });
  audit(actor, "user.create", u.login, u.role);
  return u;
}
async function resetPassword(actor, id, pw) {
  const u = mustUser(id);
  await auth.setPassword(u, pw);
  audit(actor, "user.password", u.login);
}

/* ---------- Telegram identities ---------- */
function upsertTgUser(from, chatId) {
  const key = String(from.id);
  let t = store.db.tgUsers[key];
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 40);
  if (!t) {
    t = store.db.tgUsers[key] = { id: key, chatId: String(chatId), name, username: from.username || "", userId: null, notifyNew: false, blocked: false, createdAt: Date.now() };
    store.bump("tg");
  } else if (t.name !== name || t.username !== (from.username || "") || String(t.chatId) !== String(chatId)) {
    t.name = name; t.username = from.username || ""; t.chatId = String(chatId);
    store.save();
  }
  return t;
}
/* Phone number shared through Telegram's "contact" button. Only the sender's own contact is accepted. */
function normPhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length >= 9 && d.length <= 15 ? "+" + d : "";
}
function setTgPhone(tgUser, contact, from) {
  if (!contact || String(contact.user_id) !== String(from.id)) throw E(400, "phone", "Faqat oʻzingizning raqamingizni yuboring: pastdagi tugmani bosing.");
  const p = normPhone(contact.phone_number);
  if (!p) throw E(400, "phone", "Telefon raqami notoʻgʻri.");
  tgUser.phone = p; tgUser.phoneAt = Date.now();
  store.bump("tg");
  return p;
}
function linkTelegram(tgUser, code) {
  const key = String(code || "").trim().toUpperCase();
  const lc = store.db.linkCodes[key];
  if (!lc || lc.exp < Date.now()) throw E(400, "code", "Kod notoʻgʻri yoki muddati tugagan.");
  const u = auth.findById(lc.uid);
  if (!u || u.blocked) throw E(400, "code", "Hisob topilmadi yoki bloklangan.");
  delete store.db.linkCodes[key];
  // one Telegram <-> one account
  store.db.users.forEach(x => { if (x.telegramId === tgUser.id) delete x.telegramId; });
  Object.values(store.db.tgUsers).forEach(t => { if (t.userId === u.id) t.userId = null; });
  u.telegramId = tgUser.id; tgUser.userId = u.id;
  if (isMod(u) && store.db.settings.notifyAdmins) tgUser.notifyNew = true;
  // reports the user already made from this Telegram become theirs
  allReports().forEach(r => { if (r.authorId === "tg:" + tgUser.id) r.authorId = u.id; });
  audit(u, "telegram.link", u.login, "@" + (tgUser.username || tgUser.id));
  store.bump("tg");
  return u;
}
function unlinkTelegramByUser(user) {
  const t = user.telegramId && store.db.tgUsers[String(user.telegramId)];
  if (t) t.userId = null;
  delete user.telegramId;
  audit(user, "telegram.unlink", user.login);
  store.bump("tg");
}
function tgModerator(tgUser) {
  const u = tgUser && tgUser.userId && auth.findById(tgUser.userId);
  return isMod(u) ? u : null;
}

/* ---------- settings / import ---------- */
function setSettings(actor, o) {
  const s = store.db.settings;
  if (o.notifyChatId !== undefined) {
    const v = String(o.notifyChatId || "").trim();
    if (v && !/^-?\d{5,20}$|^@[A-Za-z0-9_]{5,32}$/.test(v)) throw E(400, "chat", "Chat ID raqam (masalan -1001234567890) yoki @kanal_nomi boʻlsin.");
    s.notifyChatId = v;
  }
  if (o.notifyAdmins !== undefined) s.notifyAdmins = !!o.notifyAdmins;
  audit(actor, "settings.set", "", JSON.stringify({ notifyChatId: s.notifyChatId, notifyAdmins: s.notifyAdmins }));
  store.bump("settings");
  return s;
}

/* Import reports saved by the old browser-only version (localStorage "td:data": {r, p, f}) */
function importLegacy(actor, d) {
  const out = { reports: 0, responses: 0, photos: 0, skipped: 0 };
  const reps = Array.isArray(d && d.r) ? d.r : [], resp = Array.isArray(d && d.p) ? d.p : [], ph = Array.isArray(d && d.f) ? d.f : [];
  const photoMap = new Map(ph.filter(x => Array.isArray(x)));
  reps.forEach(r => {
    if (!r || !/^TD-[A-Z0-9]{4,10}$/.test(String(r.code)) || store.db.reports[r.code]) { out.skipped++; return; }
    if (!C.TYPES[r.type] || !isFinite(r.lat) || !isFinite(r.lon)) { out.skipped++; return; }
    const rep = {
      code: r.code, type: r.type, species: r.species || null, count: r.count || null, danger: !!r.danger, active: !!r.active,
      lat: Number(r.lat), lon: Number(r.lon), accuracy: r.accuracy || null, source: r.source === "gps" ? "gps" : "map",
      district: C.DISTRICTS.indexOf(r.district) >= 0 ? r.district : "", landmark: clip(r.landmark, 100), address: clip(r.address, 220),
      description: clip(r.description, 600), name: clip(r.name, 40), authorId: null, tgId: null, via: "web",
      createdAt: Number(r.createdAt) || Date.now(), hasPhoto: false
    };
    const p = photoMap.get(r.code);
    if (typeof p === "string") { try { const b = decodePhoto(p, 900 * 1024); if (b) { store.savePhoto(r.code, b); rep.hasPhoto = true; out.photos++; } } catch (e) {} }
    store.db.reports[r.code] = rep; out.reports++;
  });
  resp.forEach(x => {
    if (!Array.isArray(x) || !store.db.reports[x[0]] || store.db.responses[x[0]] || !x[1] || !C.STATUS[x[1].status]) return;
    const v = x[1];
    store.db.responses[x[0]] = { status: v.status, org: clip(v.org, 80), text: clip(v.text, 800), createdAt: v.createdAt || Date.now(), updatedAt: v.updatedAt || Date.now(), by: clip(v.by, 40) };
    out.responses++;
  });
  audit(actor, "import", "", JSON.stringify(out));
  store.bump("import");
  return out;
}

module.exports = {
  isMod, isSuper, audit, createReport, decodePhoto, view, setResponse, deleteReport, statusOf, isOpen, isUrgent, allReports,
  overview, setRole, setBlocked, removeUser, createByAdmin, resetPassword,
  upsertTgUser, setTgPhone, linkTelegram, unlinkTelegramByUser, tgModerator, setSettings, importLegacy
};
