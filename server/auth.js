"use strict";
const crypto = require("crypto");
const cfg = require("./env");
const store = require("./store");
const { ROLES } = require("./constants");

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; if (extra) Object.assign(this, extra); }
}
const E = (status, code, message, extra) => new HttpError(status, code, message, extra);

const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILS = 5, LOCK_MS = 30 * 1000;

/* ---------- passwords (scrypt) ---------- */
function scrypt(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(String(pw), salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k.toString("hex"))));
}
async function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: "s1:" + await scrypt(pw, salt) };
}
async function checkPw(user, pw) {
  const h = "s1:" + await scrypt(pw, user.salt);
  const a = Buffer.from(h), b = Buffer.from(String(user.hash || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function checkPwRules(pw) {
  pw = String(pw || "");
  if (pw.length < 8) throw E(400, "password", "Parol kamida 8 ta belgidan iborat boʻlsin.");
  if (pw.length > 100) throw E(400, "password", "Parol juda uzun (100 belgigacha).");
  if (!/[A-Za-zЀ-ӿ]/.test(pw) || !/[0-9]/.test(pw)) throw E(400, "password", "Parolda kamida bitta harf va bitta raqam boʻlsin.");
}
const normLogin = s => String(s || "").trim().toLowerCase();
function cleanName(s) { return String(s || "").trim().replace(/\s+/g, " "); }
function validateProfile(o) {
  const name = cleanName(o.name), login = normLogin(o.login);
  if (name.length < 2 || name.length > 40) throw E(400, "name", "Ism 2 dan 40 gacha belgidan iborat boʻlsin.");
  if (!/^[a-z0-9._@+-]{3,40}$/.test(login)) throw E(400, "login", "Login 3–40 belgi: lotin harflari, raqamlar va . _ @ + - belgilari.");
  return { name, login };
}

/* ---------- users ---------- */
function pub(u) {
  return { id: u.id, login: u.login, name: u.name, role: u.role, blocked: !!u.blocked, mustChange: !!u.mustChange, createdAt: u.createdAt || 0, telegram: !!u.telegramId };
}
const findById = id => store.db.users.find(u => u.id === id) || null;
const findByLogin = l => store.db.users.find(u => u.login === normLogin(l)) || null;
const activeSupers = () => store.db.users.filter(u => u.role === "superadmin" && !u.blocked);

async function createUser({ name, login, password, role, mustChange }) {
  const v = validateProfile({ name, login });
  checkPwRules(password);
  if (role && ROLES.indexOf(role) < 0) throw E(400, "role", "Notoʻgʻri rol.");
  if (findByLogin(v.login)) throw E(409, "exists", "Bu login band. Boshqa login tanlang.");
  const h = await hashPw(password);
  if (findByLogin(v.login)) throw E(409, "exists", "Bu login band. Boshqa login tanlang.");
  const u = { id: store.id("u_"), login: v.login, name: v.name, role: role || "user", salt: h.salt, hash: h.hash, blocked: false, mustChange: !!mustChange, createdAt: Date.now() };
  store.db.users.push(u);
  store.bump("users");
  return u;
}

/* First start: make sure a super admin exists. */
async function seedSuperadmin() {
  if (store.db.users.some(u => u.role === "superadmin")) return null;
  let pw = cfg.SUPERADMIN_PASSWORD, generated = false;
  if (!pw) { pw = crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "x") + "7a"; generated = true; }
  if (!generated) {
    try { checkPwRules(pw); }
    catch (e) {
      console.warn("[auth] SUPERADMIN_PASSWORD .env faylida qoidalarga mos emas (" + e.message + ") — tasodifiy parol yaratildi.");
      pw = crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "x") + "7a"; generated = true;
    }
  }
  let login = cfg.SUPERADMIN_LOGIN;
  if (findByLogin(login)) login = login + "." + crypto.randomBytes(2).toString("hex");
  await createUser({ name: cfg.SUPERADMIN_NAME, login, password: pw, role: "superadmin", mustChange: generated });
  return { login, password: pw, generated };
}

/* ---------- sessions ---------- */
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
function createSession(uid) {
  const token = crypto.randomBytes(32).toString("hex");
  store.db.sessions[sha(token)] = { uid, exp: Date.now() + SESSION_MS };
  store.save();
  return token;
}
function destroySession(token) { if (token && store.db.sessions[sha(token)]) { delete store.db.sessions[sha(token)]; store.save(); } }
function destroyUserSessions(uid, exceptToken) {
  const keep = exceptToken ? sha(exceptToken) : null;
  Object.keys(store.db.sessions).forEach(k => { if (store.db.sessions[k].uid === uid && k !== keep) delete store.db.sessions[k]; });
  store.save();
}
function tokenOf(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(h);
  return m ? m[1].toLowerCase() : null;
}
function userFromToken(token) {
  if (!token) return null;
  const s = store.db.sessions[sha(token)];
  if (!s) return null;
  if (s.exp < Date.now()) { delete store.db.sessions[sha(token)]; return null; }
  const u = findById(s.uid);
  return u && !u.blocked ? u : null;
}
setInterval(() => {
  const now = Date.now(); let n = 0;
  Object.keys(store.db.sessions).forEach(k => { if (store.db.sessions[k].exp < now) { delete store.db.sessions[k]; n++; } });
  Object.keys(store.db.linkCodes).forEach(k => { if (store.db.linkCodes[k].exp < now) { delete store.db.linkCodes[k]; n++; } });
  if (n) store.save();
}, 10 * 60 * 1000).unref();

/* ---------- throttles ---------- */
const fails = new Map();   // key -> {n, until}
function checkLock(key) {
  const f = fails.get(key);
  if (f && f.until > Date.now()) {
    const sec = Math.ceil((f.until - Date.now()) / 1000);
    throw E(429, "locked", "Juda koʻp urinish. " + sec + " soniyadan keyin qayta urinib koʻring.", { seconds: sec });
  }
}
function noteFail(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  if (f.until && f.until <= Date.now()) f.n = 0;
  f.n++;
  if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  fails.set(key, f);
  if (fails.size > 5000) fails.clear();
}
const clearFail = key => fails.delete(key);

const buckets = new Map();
/* rate(key, limit, windowMs): throws 429 when exceeded */
function rate(key, limit, windowMs, message) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) throw E(429, "rate", message || "Juda koʻp soʻrov. Birozdan soʻng urinib koʻring.");
  arr.push(now); buckets.set(key, arr);
  if (buckets.size > 20000) buckets.clear();
}

/* ---------- actions ---------- */
async function register({ name, login, password }, ip) {
  rate("reg:" + ip, 10, 3600e3, "Bu manzildan juda koʻp hisob ochildi. Keyinroq urinib koʻring.");
  const u = await createUser({ name, login, password, role: "user" });
  return { user: pub(u), token: createSession(u.id) };
}
async function login(loginName, password, ip) {
  const l = normLogin(loginName), key = ip + "|" + l;
  checkLock(key);
  const u = findByLogin(l);
  const bad = E(401, "credentials", "Login yoki parol notoʻgʻri.");
  if (!u) { await scrypt(String(password || ""), "00000000000000000000000000000000"); noteFail(key); throw bad; }
  if (!(await checkPw(u, String(password || "")))) { noteFail(key); throw bad; }
  if (u.blocked) throw E(403, "blocked", "Bu hisob bloklangan. Moderatorga murojaat qiling.");
  clearFail(key);
  return { user: pub(u), token: createSession(u.id) };
}
async function changePassword(user, oldPw, newPw, token) {
  checkPwRules(newPw);
  if (oldPw === newPw) throw E(400, "password", "Yangi parol eskisidan farq qilsin.");
  if (!(await checkPw(user, String(oldPw || "")))) throw E(400, "credentials", "Joriy parol notoʻgʻri.");
  const h = await hashPw(newPw);
  user.salt = h.salt; user.hash = h.hash; user.mustChange = false;
  destroyUserSessions(user.id, token);
  store.bump("users");
}
async function setPassword(user, newPw) {
  checkPwRules(newPw);
  const h = await hashPw(newPw);
  user.salt = h.salt; user.hash = h.hash; user.mustChange = false;
  destroyUserSessions(user.id);
  store.bump("users");
}

/* Telegram link codes: logged-in user asks for a code, sends "/link CODE" to the bot */
function newLinkCode(user) {
  Object.keys(store.db.linkCodes).forEach(k => { if (store.db.linkCodes[k].uid === user.id) delete store.db.linkCodes[k]; });
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const b = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += A[b[i] % A.length];
  store.db.linkCodes[code] = { uid: user.id, exp: Date.now() + 10 * 60 * 1000 };
  store.save();
  return code;
}

module.exports = {
  HttpError, E, pub, findById, findByLogin, activeSupers, createUser, seedSuperadmin,
  createSession, destroySession, destroyUserSessions, tokenOf, userFromToken,
  register, login, changePassword, setPassword, checkPwRules, newLinkCode,
  rate, validateProfile, normLogin, cleanName
};
