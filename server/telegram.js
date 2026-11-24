"use strict";
/* Thin Telegram Bot API client built on fetch (Node 18+). No dependencies. */
const cfg = require("./env");

class TgError extends Error {
  constructor(method, body, status) {
    super("Telegram " + method + ": " + (body && body.description || ("HTTP " + status)));
    this.method = method; this.code = body && body.error_code || status;
    this.retryAfter = body && body.parameters && body.parameters.retry_after || 0;
  }
}

/* params: plain object (objects/arrays are JSON-encoded); files: {fieldName: {buf, filename, mime}} */
async function call(method, params, files, timeoutMs) {
  if (!cfg.BOT_TOKEN) throw new TgError(method, { description: "bot token not set", error_code: 401 });
  const url = cfg.TG_API + "/bot" + cfg.BOT_TOKEN + "/" + method;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs || 25000);
    try {
      let init;
      if (files && Object.keys(files).length) {
        const fd = new FormData();
        Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) fd.append(k, typeof v === "object" ? JSON.stringify(v) : String(v)); });
        Object.entries(files).forEach(([k, f]) => fd.append(k, new Blob([f.buf], { type: f.mime || "application/octet-stream" }), f.filename || "file"));
        init = { method: "POST", body: fd, signal: ac.signal };
      } else {
        init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}), signal: ac.signal };
      }
      const r = await fetch(url, init);
      let body = null;
      try { body = await r.json(); } catch (e) {}
      if (body && body.ok) return body.result;
      const err = new TgError(method, body, r.status);
      if (err.code === 429 && attempt === 0) { await new Promise(res => setTimeout(res, Math.min(30, err.retryAfter || 3) * 1000)); continue; }
      throw err;
    } catch (e) {
      if (e instanceof TgError) throw e;
      throw new TgError(method, { description: e.name === "AbortError" ? "timeout" : (e.cause && e.cause.code) || e.message, error_code: 0 }, 0);
    } finally { clearTimeout(timer); }
  }
}

async function downloadFile(filePath) {
  const r = await fetch(cfg.TG_API + "/file/bot" + cfg.BOT_TOKEN + "/" + filePath);
  if (!r.ok) throw new TgError("download", { description: "HTTP " + r.status }, r.status);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { call, downloadFile, TgError };
