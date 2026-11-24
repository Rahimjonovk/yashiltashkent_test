"use strict";
/* Tiny JSON document store: one file for records + one file per photo.
   Single-process, atomic writes (tmp + rename), debounced. Good for thousands of reports. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const cfg = require("./env");

const FILE = path.join(cfg.DATA_DIR, "db.json");
const PHOTO_DIR = path.join(cfg.DATA_DIR, "photos");
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const empty = () => ({
  v: 1, version: 1,
  users: [],            // {id, login, name, role, salt, hash, blocked, mustChange, createdAt, telegramId}
  sessions: {},         // sha256(token) -> {uid, exp}
  reports: {},          // code -> report
  responses: {},        // code -> {status, org, text, createdAt, updatedAt, by}
  tgUsers: {},          // telegramId -> {id, chatId, name, username, userId, notifyNew, blocked, createdAt}
  linkCodes: {},        // code -> {uid, exp}
  audit: [],            // {ts, actor, actorName, action, target, detail}
  settings: { notifyChatId: "", notifyAdmins: true }
});

let db = empty();
try {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  db = Object.assign(empty(), raw);
  db.settings = Object.assign(empty().settings, raw.settings || {});
} catch (e) {
  if (e.code !== "ENOENT") {
    // Never silently discard a corrupt DB: keep a copy and refuse to continue with an empty one.
    const bad = FILE + ".corrupt-" + Date.now();
    try { fs.copyFileSync(FILE, bad); } catch (e2) {}
    console.error("[store] db.json is unreadable (" + e.message + "). Copy saved to " + bad + ". Fix or remove db.json and restart.");
    process.exit(1);
  }
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

let timer = null, lastBackup = 0, writing = false, again = false;
function flushSync() {
  clearTimeout(timer); timer = null;
  const tmp = FILE + ".tmp";
  const json = JSON.stringify(db);
  fs.writeFileSync(tmp, json);
  try {
    if (Date.now() - lastBackup > 10 * 60 * 1000 && fs.existsSync(FILE)) { fs.copyFileSync(FILE, FILE + ".bak"); lastBackup = Date.now(); }
  } catch (e) {}
  fs.renameSync(tmp, FILE);
}
function save() {
  if (timer) return;
  timer = setTimeout(() => { try { flushSync(); } catch (e) { console.error("[store] write failed:", e.message); } }, 250);
}
/* bump(): mark data as changed for clients (SSE) and persist */
function bump(kind) {
  db.version++;
  save();
  bus.emit("change", { v: db.version, kind: kind || "data" });
}

function id(prefix) { return prefix + crypto.randomBytes(6).toString("hex"); }

/* ---- photos ---- */
function sniff(buf) {
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}
const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
function photoPath(code, ext) { return path.join(PHOTO_DIR, code + "." + ext); }
function savePhoto(code, buf) {
  const ext = sniff(buf);
  if (!ext) throw Object.assign(new Error("Rasm formati notoʻgʻri (JPEG, PNG yoki WebP)."), { code: "photo" });
  removePhoto(code);
  fs.writeFileSync(photoPath(code, ext), buf);
  return ext;
}
function readPhoto(code) {
  for (const ext of ["jpg", "png", "webp"]) {
    try { return { buf: fs.readFileSync(photoPath(code, ext)), mime: MIME[ext] }; } catch (e) {}
  }
  return null;
}
function removePhoto(code) {
  for (const ext of ["jpg", "png", "webp"]) { try { fs.unlinkSync(photoPath(code, ext)); } catch (e) {} }
}

function shutdown() { try { if (timer) flushSync(); } catch (e) { console.error(e); } }
process.on("exit", shutdown);
["SIGINT", "SIGTERM"].forEach(s => process.on(s, () => { shutdown(); process.exit(0); }));

module.exports = {
  get db() { return db; }, bus, save, bump, flushSync, id,
  savePhoto, readPhoto, removePhoto, sniff, FILE, PHOTO_DIR
};
