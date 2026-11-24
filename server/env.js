"use strict";
/* Minimal .env loader (no dependencies) + typed config. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function loadEnvFile(file) {
  let txt = "";
  try { txt = fs.readFileSync(file, "utf8"); } catch (e) { return; }
  txt.split(/\r?\n/).forEach(line => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}
loadEnvFile(path.join(ROOT, ".env"));

const env = process.env;
const num = (v, d) => { const n = Number(v); return isFinite(n) && v !== undefined && v !== "" ? n : d; };

module.exports = {
  ROOT,
  PORT: num(env.PORT, 3000),
  HOST: env.HOST || "0.0.0.0",
  DATA_DIR: path.resolve(ROOT, env.DATA_DIR || "data"),
  PUBLIC_DIR: path.join(ROOT, "public"),
  PUBLIC_URL: (env.PUBLIC_URL || "").replace(/\/+$/, ""),   // e.g. https://yashil.example.uz  (needed for links inside Telegram)
  TRUST_PROXY: env.TRUST_PROXY === "1",
  CORS_ORIGINS: (env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
  SUPERADMIN_LOGIN: (env.SUPERADMIN_LOGIN || "superadmin").trim().toLowerCase(),
  SUPERADMIN_PASSWORD: env.SUPERADMIN_PASSWORD || "",
  SUPERADMIN_NAME: env.SUPERADMIN_NAME || "Super admin",
  BOT_TOKEN: (env.TELEGRAM_BOT_TOKEN || "").trim(),
  TG_API: (env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, ""),
  NOMINATIM_URL: (env.NOMINATIM_URL || "https://nominatim.openstreetmap.org").replace(/\/+$/, ""),
  OVERPASS_URL: env.OVERPASS_URL || "https://overpass-api.de/api/interpreter",
  GEO_CONTACT: env.GEO_CONTACT || "",       // contact e-mail/URL for the Nominatim User-Agent (their usage policy asks for it)
  GEO_DISABLED: env.GEO_DISABLED === "1"
};
