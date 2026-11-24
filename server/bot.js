"use strict";
/* Telegram bot. Uses exactly the same service layer (service.js) and data as the website:
   - a report made on the site is listed in the bot (and pushed to subscribers / moderators / the notify group)
   - a report made in the bot appears on the site at once (SSE)
   - a moderator's reply, from either side, is delivered to the author in Telegram */
const cfg = require("./env");
const store = require("./store");
const auth = require("./auth");
const svc = require("./service");
const geo = require("./geocode");
const tg = require("./telegram");
const C = require("./constants");
const { E } = auth;

let me = null, looping = false, lastError = "", startedAt = 0;
/* private chat id -> {flow, step, d, ts, ...}. Keys are always strings: callbacks carry the id as a string (stored chatId),
   messages carry a number, and 5001 !== "5001" would silently lose the dialog state. */
class SessionMap extends Map {
  get(k) { return super.get(String(k)); }
  set(k, v) { return super.set(String(k), v); }
  has(k) { return super.has(String(k)); }
  delete(k) { return super.delete(String(k)); }
}
const sessions = new SessionMap();

const BTN = {
  new: "📝 Yangi murojaat", list: "📋 Murojaatlar", mine: "📂 Mening murojaatlarim", find: "🔎 Raqam boʻyicha",
  help: "ℹ️ Yordam", mod: "🛠 Moderator", cancel: "❌ Bekor qilish", loc: "📍 Joylashuvni yuborish", phone: "📱 Telefon raqamni yuborish"
};
const MENU_LABELS = [BTN.new, BTN.list, BTN.mine, BTN.find, BTN.help, BTN.mod];

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const h = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MONTHS = ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"];
function fdate(ts) {
  const d = new Date(ts + 5 * 3600e3), p = n => String(n).padStart(2, "0");   // Tashkent = UTC+5, no DST
  return d.getUTCDate() + "-" + MONTHS[d.getUTCMonth()] + ", " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}
const logErr = (what, e) => console.error("[bot] " + what + ":", e && e.message || e);
const ik = rows => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

function siteUrl(code) {
  const u = cfg.PUBLIC_URL;
  if (!/^https:\/\//.test(u) || /localhost|127\.0\.0\.1|192\.168\.|\/\/10\./.test(u)) return null;   // Telegram refuses non-public URL buttons
  return u + "/index.html" + (code ? "#" + code : "");
}

/* serialized outgoing queue (~25 msg/s, well under Telegram's limits) */
let qTail = Promise.resolve();
function api(method, params, files) {
  const p = qTail.then(() => tg.call(method, params, files));
  qTail = p.catch(() => {}).then(() => sleep(40));
  return p;
}
const say = (chat, text, extra) =>
  api("sendMessage", Object.assign({ chat_id: chat, text: String(text).slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }, extra || {})).catch(e => { logErr("sendMessage", e); return null; });
const answer = (cq, text, alert) => api("answerCallbackQuery", { callback_query_id: cq.id, text: text ? String(text).slice(0, 190) : undefined, show_alert: !!alert }).catch(() => {});

function menuMarkup(t) {
  const rows = [[BTN.new, BTN.list], [BTN.mine, BTN.find]];
  const last = [BTN.help]; if (svc.tgModerator(t)) last.push(BTN.mod);
  rows.push(last);
  return { keyboard: rows.map(r => r.map(text => ({ text }))), resize_keyboard: true };
}

/* ---------- rendering ---------- */
function mineList(t) {
  return svc.allReports().filter(r => r.tgId === t.id || r.authorId === "tg:" + t.id || (t.userId && r.authorId === t.userId));
}

function renderReport(r, o) {
  o = o || {};
  const ty = C.TYPES[r.type] || C.TYPES.zarar, st = svc.statusOf(r.code), s = C.STATUS[st], resp = store.db.responses[r.code];
  const build = desc => {
    const L = [];
    if (o.header) L.push(o.header, "");
    L.push(ty.emoji + " <b>" + h(ty.label) + "</b> · <code>" + r.code + "</code>");
    L.push(s.emoji + " " + h(s.label) + (svc.isUrgent(r) && svc.isOpen(r.code) ? "   ⚠️ <b>Shoshilinch</b>" : ""));
    L.push("📍 " + h(r.address || (r.district + " tumani")));
    if (r.address && r.district && r.address.indexOf(r.district) < 0) L.push("🏙 " + h(r.district) + " tumani");
    if (r.landmark) L.push("🧭 Moʻljal: " + h(r.landmark));
    if (ty.tree) L.push("🌳 " + h(r.species || "Koʻrsatilmagan") + " · " + h(C.COUNTS[r.count] || r.count || ""));
    if (r.danger) L.push("🚧 Odamlar, avtomobil yoki bino uchun xavf bor");
    if (r.active) L.push("🪓 Kesish yuborilgan vaqtda davom etayotgan edi");
    L.push("📝 " + h(desc));
    L.push("👤 " + h(r.name || "Fuqaro") + " · " + fdate(r.createdAt) + " · " + (r.via === "telegram" ? "Telegram" : "Sayt"));
    if (o.phone && r.phone) L.push("📞 " + h(r.phone));
    if (resp && (resp.text || resp.org)) {
      L.push("", "💬 <b>Javob</b>" + (resp.org ? " (" + h(resp.org) + ")" : "") + (resp.text ? ":\n" + h(resp.text) : ""));
    }
    return L.join("\n");
  };
  let text = build(r.description);
  if (o.photo && text.length > 1000) text = build(r.description.slice(0, Math.max(40, r.description.length - (text.length - 990))) + "…");
  const rows = [];
  if (o.mod) {
    rows.push([btn("🟡 Koʻrib chiqilmoqda", "m:" + r.code + ":k"), btn("✅ Hal qilindi", "m:" + r.code + ":h")]);
    rows.push([btn("⛔ Rad etish", "m:" + r.code + ":r"), btn("💬 Javob yozish", "r:" + r.code)]);
  }
  const links = [{ text: "🗺 Xaritada", url: "https://www.openstreetmap.org/?mlat=" + r.lat + "&mlon=" + r.lon + "#map=18/" + r.lat + "/" + r.lon }];
  const su = siteUrl(r.code); if (su) links.push({ text: "🌐 Saytda", url: su });
  rows.push(links);
  return { text, markup: ik(rows) };
}

async function sendCard(chat, r, card) {
  if (r.hasPhoto) {
    const p = store.readPhoto(r.code);
    if (p) {
      try {
        return await api("sendPhoto", { chat_id: chat, caption: card.text, parse_mode: "HTML", reply_markup: card.markup }, { photo: { buf: p.buf, filename: r.code + ".jpg", mime: p.mime } });
      } catch (e) { logErr("sendPhoto", e); }
    }
  }
  return say(chat, card.text, { reply_markup: card.markup });
}
/* the author's phone number is shown only to moderators, in their private chat (never in the notify group) */
const cardFor = (r, t, header) => { const mod = !!svc.tgModerator(t); return renderReport(r, { mod, phone: mod, header, photo: !!r.hasPhoto }); };

/* ---------- lists ---------- */
const PAGE = 6;
function listPage(filter, page, t) {
  let list = svc.allReports();
  if (filter === "open") list = list.filter(r => svc.isOpen(r.code));
  else if (filter === "urg") list = list.filter(r => svc.isUrgent(r) && svc.isOpen(r.code));
  else if (filter === "mine") list = mineList(t);
  list.sort((a, b) => b.createdAt - a.createdAt);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const names = { all: "Barcha murojaatlar", open: "Hal etilmaganlar", urg: "Shoshilinch", mine: "Mening murojaatlarim" };
  const total = svc.allReports().length, open = svc.allReports().filter(r => svc.isOpen(r.code)).length;
  const head = "📋 <b>" + names[filter] + "</b>: " + list.length + " ta" + (filter === "all" ? " (hal etilmagan: " + open + ")" : "") + (pages > 1 ? "\nSahifa " + (page + 1) + "/" + pages : "");
  const rows = list.slice(page * PAGE, page * PAGE + PAGE).map(r => {
    const ty = C.TYPES[r.type] || C.TYPES.zarar;
    return [btn(C.STATUS[svc.statusOf(r.code)].emoji + (svc.isUrgent(r) && svc.isOpen(r.code) ? "⚠️" : "") + " " + r.code + " · " + ty.short + " · " + r.district, "v:" + r.code)];
  });
  if (pages > 1) rows.push([btn("⬅️", "l:" + filter + ":" + Math.max(0, page - 1)), btn((page + 1) + "/" + pages, "noop"), btn("➡️", "l:" + filter + ":" + Math.min(pages - 1, page + 1))]);
  rows.push([btn(filter === "all" ? "• Barchasi" : "Barchasi", "l:all:0"), btn(filter === "open" ? "• Ochiq" : "Ochiq", "l:open:0"), btn(filter === "urg" ? "• ⚠️" : "⚠️ Shoshilinch", "l:urg:0"), btn(filter === "mine" ? "• Meniki" : "Meniki", "l:mine:0")]);
  return { text: total || list.length ? head : "Hozircha murojaat yoʻq. 📝 «Yangi murojaat» tugmasi bilan birinchisini yuboring.", markup: ik(rows) };
}

/* ---------- new-report flow ---------- */
function nextStep(d, t) {
  if (!t.phone) return "phone";
  if (d.lat == null) return "loc";
  if (!d.confirmed) return "locConfirm";
  if (!d.type) return "type";
  if (C.TYPES[d.type].tree) { if (!d.species) return "species"; if (!d.count) return "count"; }
  if (d.danger === undefined) return "danger";
  if (d.type === "kesish" && d.active === undefined) return "active";
  if (!d.description) return "desc";
  if (!d.photoDone) return "photo";
  return "confirm";
}
const cancelRow = [btn("❌ Bekor qilish", "n:x")];

const locKeyboard = { keyboard: [[{ text: BTN.loc, request_location: true }], [{ text: BTN.cancel }]], resize_keyboard: true };
const phoneKeyboard = { keyboard: [[{ text: BTN.phone, request_contact: true }], [{ text: BTN.cancel }]], resize_keyboard: true };
const PHONE_TEXT = "📱 <b>Telefon raqamingiz</b>\nMurojaatni tekshirish uchun moderator siz bilan bogʻlanishi mumkin. Pastdagi «" + BTN.phone + "» tugmasini bosing — Telegramga bogʻlangan raqamingiz yuboriladi (bir marta soʻraladi).\n<i>Raqam ochiq koʻrsatilmaydi: uni faqat moderatorlar koʻradi.</i>";
const LOC_TEXT = "📍 <b>1. Joylashuv</b>\nMuammo qayerda? Quyidagilardan birini qiling:\n• «" + BTN.loc + "» tugmasi — qurilma joylashuvi (daraxt yonida boʻlsangiz)\n• 📎 → <i>Joylashuv</i> → xaritada nuqtani tanlang\n• yoki manzilni yozing, masalan: <i>Chilonzor 43-uy</i>\n\nBot nuqta boʻyicha toʻliq manzilni aniqlaydi.";

function startNew(chat, t) {
  const s = { flow: "new", step: "loc", d: {}, ts: Date.now() };
  sessions.set(chat, s);
  return prompt(chat, s, t);
}

async function prompt(chat, s, t) {
  s.step = nextStep(s.d, t); s.ts = Date.now();
  const d = s.d;
  switch (s.step) {
    case "phone":
      return say(chat, PHONE_TEXT, { reply_markup: phoneKeyboard });
    case "loc":
      return say(chat, LOC_TEXT, { reply_markup: locKeyboard });
    case "type":
      return say(chat, "🌳 <b>2. Muammo turi</b>\n" + Object.entries(C.TYPES).map(([k, v]) => v.emoji + " <b>" + h(v.label) + "</b> — " + h(C.TYPE_HINTS[k])).join("\n"),
        { reply_markup: ik(Object.entries(C.TYPES).map(([k, v]) => [btn(v.emoji + " " + v.label, "n:t:" + k)]).concat([cancelRow])) });
    case "species":
      return say(chat, "🌿 <b>Daraxt turi</b>", { reply_markup: ik(chunk(C.SPECIES.map((x, i) => btn(x, "n:s:" + i)), 3).concat([[btn("Boshqa…", "n:s:o"), btn("Nomaʼlum", "n:s:u")], cancelRow])) });
    case "count":
      return say(chat, d.type === "kesish" ? "🔢 <b>Kesilgan daraxtlar soni</b>" : "🔢 <b>Daraxtlar soni</b>", { reply_markup: ik([Object.entries(C.COUNTS).map(([k, v]) => btn(v, "n:c:" + k)), cancelRow]) });
    case "danger":
      return say(chat, "🚧 Odamlar, avtomobil yoki bino uchun xavf bormi?\n<i>«Ha» desangiz murojaat «Shoshilinch» deb belgilanadi.</i>", { reply_markup: ik([[btn("Ha, xavf bor", "n:g:1"), btn("Yoʻq", "n:g:0")], cancelRow]) });
    case "active":
      return say(chat, "🪓 Kesish hozir davom etmoqdami?\n<i>«Ha» desangiz murojaat «Shoshilinch» deb belgilanadi.</i>", { reply_markup: ik([[btn("Ha, davom etmoqda", "n:a:1"), btn("Yoʻq", "n:a:0")], cancelRow]) });
    case "desc":
      return say(chat, "📝 <b>Nima koʻrdingiz?</b>\nMuammoni qisqa va aniq yozing: nima, qayerda, qachondan beri (10–600 belgi).", { reply_markup: ik([cancelRow]) });
    case "photo":
      return say(chat, "📷 Rasm yuboring (ixtiyoriy) yoki rasmsiz davom eting.", { reply_markup: ik([[btn("⏭ Rasmsiz davom etish", "n:p:skip")], cancelRow]) });
    case "confirm": {
      const ty = C.TYPES[d.type];
      const L = ["📋 <b>Murojaatni tekshiring</b>", "", ty.emoji + " <b>" + h(ty.label) + "</b>", "📍 " + h(d.address || (d.district + " tumani")) + (d.address && d.address.indexOf(d.district) < 0 ? " (" + h(d.district) + " tumani)" : "")];
      if (ty.tree) L.push("🌳 " + h(d.species) + " · " + h(C.COUNTS[d.count]));
      if (d.danger) L.push("🚧 Xavf bor"); if (d.active) L.push("🪓 Kesish davom etmoqda");
      L.push("📝 " + h(d.description), "📷 Rasm: " + (d.photo ? "bor" : "yoʻq"));
      return say(chat, L.join("\n"), { reply_markup: ik([[btn("✅ Yuborish", "n:y"), btn("❌ Bekor qilish", "n:x")]]) });
    }
  }
}

async function resolveLocation(chat, s, t, lat, lon, accuracy, kind) {
  if (!C.inPlace(lat, lon)) { return say(chat, "⚠️ Bu nuqta Toshkent hududidan tashqarida. Shahar ichidagi joyni yuboring."); }
  const d = s.d;
  d.lat = lat; d.lon = lon; d.accuracy = accuracy || null; d.source = kind || (accuracy ? "gps" : "map"); d.confirmed = false; d.address = ""; d.district = ""; d.addrApprox = false;
  await say(chat, "🔎 Manzil aniqlanmoqda…");
  try {
    const r = await geo.reverse(lat, lon);
    d.address = r.address; d.district = r.district;
  } catch (e) { logErr("geocode", e); }
  if (!d.district) d.district = C.nearestDistrict(lat, lon);   // the district is always detected automatically, never asked
  s.step = "locConfirm"; s.ts = Date.now();
  const txt = d.address
    ? "📍 <b>Manzil:</b> " + h(d.address) + (d.address.indexOf(d.district) < 0 ? "\n🏙 Tuman: " + h(d.district) + " tumani" : "") + "\n\nToʻgʻrimi?"
    : "📍 Joylashuv qabul qilindi: " + lat.toFixed(5) + ", " + lon.toFixed(5) + "\n🏙 Tuman: <b>" + h(d.district) + " tumani</b>\n<i>Aniq manzilni aniqlab boʻlmadi.</i>\n\nToʻgʻrimi?";
  return say(chat, txt, { reply_markup: ik([[btn("✅ Toʻgʻri", "n:ok"), btn("🔄 Boshqa joy", "n:redo")], cancelRow]) });
}

async function newText(chat, s, t, text) {
  if (s.step === "loc") {
    let res = [];
    try { res = await geo.search(text, 1); } catch (e) { if (e.status === 400) return say(chat, "⚠️ " + h(e.message)); logErr("search", e); }
    if (!res.length) return say(chat, "Bunday manzil topilmadi. Aniqroq yozing (masalan: <i>Chilonzor 43-uy</i>) yoki joylashuv yuboring.");
    const r = res[0];
    await api("sendLocation", { chat_id: chat, latitude: r.lat, longitude: r.lon }).catch(() => {});
    return resolveLocation(chat, s, t, r.lat, r.lon, null, "search");
  }
  if (s.step === "phone") return say(chat, "📱 Raqamni yozish shart emas — pastdagi «" + BTN.phone + "» tugmasini bosing. Tugma koʻrinmasa, klaviatura yonidagi ▦ belgisini bosing.", { reply_markup: phoneKeyboard });
  if (s.step === "speciesOther") {
    const v = text.trim().slice(0, 40);
    if (v.length < 2) return say(chat, "Daraxt nomini yozing (kamida 2 ta belgi).");
    s.d.species = v; return prompt(chat, s, t);
  }
  if (s.step === "desc") {
    const v = text.trim();
    if (v.length < 10) return say(chat, "Kamida 10 ta belgi yozing: nima, qayerda, qachondan beri.");
    s.d.description = v.slice(0, 600); return prompt(chat, s, t);
  }
  return say(chat, "Iltimos, yuqoridagi tugmalardan birini tanlang yoki «" + BTN.cancel + "».");
}

async function newContact(chat, s, t, m) {
  if (s.step !== "phone") return say(chat, "Telefon raqami hozir kerak emas. Yuqoridagi savolga javob bering.");
  try { svc.setTgPhone(t, m.contact, m.from); }
  catch (e) {
    if (e instanceof auth.HttpError) return say(chat, "⚠️ " + h(e.message), { reply_markup: phoneKeyboard });
    throw e;
  }
  await say(chat, "✅ Raqam qabul qilindi: <code>" + h(t.phone) + "</code>", { reply_markup: { remove_keyboard: true } });
  return prompt(chat, s, t);
}

async function newPhoto(chat, s, t, m) {
  if (s.step !== "photo") return say(chat, "Hozir rasm kerak emas. Yuqoridagi savolga javob bering.");
  const sizes = (m.photo || []).slice().sort((a, b) => (a.file_size || 0) - (b.file_size || 0));
  const pick = sizes.filter(x => (x.file_size || 0) <= 1.5 * 1024 * 1024).pop() || sizes[0];
  if (!pick) return say(chat, "Rasmni oʻqib boʻlmadi.");
  try {
    const f = await tg.call("getFile", { file_id: pick.file_id });
    const buf = await tg.downloadFile(f.file_path);
    if (buf.length > 2 * 1024 * 1024 || !store.sniff(buf)) throw new Error("bad photo");
    s.d.photo = buf; s.d.photoDone = true;
  } catch (e) { logErr("photo", e); return say(chat, "Rasmni yuklab boʻlmadi. Boshqa rasm yuboring yoki rasmsiz davom eting."); }
  return prompt(chat, s, t);
}

async function submitNew(chat, s, t) {
  const d = s.d;
  try {
    auth.rate("tgrep:" + t.id, 8, 3600e3, "Juda koʻp murojaat yuborildi. Bir soatdan keyin urinib koʻring.");
    const linked = t.userId ? auth.findById(t.userId) : null;
    const rep = svc.createReport({
      type: d.type, species: d.species, count: d.count, danger: d.danger, active: d.active, lat: d.lat, lon: d.lon, accuracy: d.accuracy,
      source: d.source === "search" ? "search" : "telegram", district: d.district, address: d.address, description: d.description
    }, { tgUser: t, user: linked && !linked.blocked ? linked : null, via: "telegram" }, d.photo || null);
    sessions.delete(chat);
    const su = siteUrl(rep.code);
    return say(chat, "✅ <b>Murojaat yuborildi</b>\n\nRaqami: <code>" + rep.code + "</code>\nUni saqlab qoʻying — javobni shu raqam bilan topasiz. Murojaat saytda ham koʻrinadi" + (su ? ": " + su : ".") + "\nJavob berilganda sizga shu yerda xabar keladi.",
      { reply_markup: menuMarkup(t) });
  } catch (e) {
    if (e instanceof auth.HttpError) {
      if (e.code === "rate") { sessions.delete(chat); return say(chat, "⚠️ " + h(e.message), { reply_markup: menuMarkup(t) }); }
      // validation problem: re-ask the offending step
      await say(chat, "⚠️ " + h(e.message));
      const reset = { loc: () => { d.lat = undefined; d.confirmed = false; }, type: () => { d.type = ""; },
        species: () => { d.species = ""; }, count: () => { d.count = ""; }, desc: () => { d.description = ""; } }[e.code];
      if (reset) reset();
      return prompt(chat, s, t);
    }
    logErr("createReport", e); return say(chat, "Murojaatni yuborib boʻlmadi. Keyinroq urinib koʻring.");
  }
}

async function newCallback(cq, chat, t, parts) {
  const s = sessions.get(chat);
  if (parts[1] === "x") { sessions.delete(chat); await answer(cq); return say(chat, "Bekor qilindi.", { reply_markup: menuMarkup(t) }); }
  if (!s || s.flow !== "new") { await answer(cq, "Bu tugma eskirgan. /yangi bilan qaytadan boshlang.", true); return; }
  const d = s.d, a = parts[1], v = parts[2];
  const stepOk = (...names) => names.indexOf(s.step) >= 0;
  let ok = true;
  if (a === "ok" && stepOk("locConfirm")) d.confirmed = true;
  else if (a === "redo" && stepOk("locConfirm")) { s.d = {}; s.step = "loc"; await answer(cq); return say(chat, "Joylashuvni qayta yuboring yoki manzilni yozing.", { reply_markup: locKeyboard }); }
  else if (a === "t" && stepOk("type") && C.TYPES[v]) { d.type = v; d.species = ""; d.count = ""; d.danger = undefined; d.active = undefined; }
  else if (a === "s" && stepOk("species")) {
    if (v === "o") { s.step = "speciesOther"; await answer(cq); return say(chat, "Daraxt nomini yozing:", { reply_markup: ik([cancelRow]) }); }
    d.species = v === "u" ? "Nomaʼlum" : C.SPECIES[+v] || ""; if (!d.species) ok = false;
  }
  else if (a === "c" && stepOk("count") && C.COUNTS[v]) d.count = v;
  else if (a === "g" && stepOk("danger")) d.danger = v === "1";
  else if (a === "a" && stepOk("active")) d.active = v === "1";
  else if (a === "p" && stepOk("photo")) d.photoDone = true;
  else if (a === "y" && stepOk("confirm")) { await answer(cq, "Yuborilmoqda…"); return submitNew(chat, s, t); }
  else ok = false;
  if (!ok) { await answer(cq, "Bu tugma hozir mos emas.", false); return; }
  await answer(cq);
  // remove the old buttons so the chat stays tidy
  api("editMessageReplyMarkup", { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  return prompt(chat, s, t);
}

/* ---------- moderator flow ---------- */
function actorFor(u, from) { return { id: u.id, name: u.name, login: u.login, via: "telegram", tgId: String(from.id) }; }

async function startReply(chat, t, code, status) {
  const r = store.db.reports[code]; if (!r) return say(chat, "Murojaat topilmadi. U oʻchirilgan boʻlishi mumkin.");
  sessions.set(chat, { flow: "reply", step: "text", code, status, ts: Date.now() });
  return say(chat, "💬 <b>" + code + "</b> uchun javob matnini yozing" + (status === "hal" ? " (<i>Hal qilindi</i>)" : status === "rad" ? " (<i>Rad etildi</i>)" : "") + ".\nKamida 5 ta belgi.",
    { reply_markup: { keyboard: [[{ text: BTN.cancel }]], resize_keyboard: true } });
}
async function finishReply(chat, s, t, org) {
  const u = svc.tgModerator(t);
  sessions.delete(chat);
  if (!u) return say(chat, "Moderator huquqi topilmadi.", { reply_markup: menuMarkup(t) });
  try {
    svc.setResponse(s.code, { status: s.status, org, text: s.text }, actorFor(u, { id: t.id }));
    await say(chat, "✅ Javob saqlandi. Muallifga xabar yuborildi.", { reply_markup: menuMarkup(t) });
    return sendCard(chat, store.db.reports[s.code], cardFor(store.db.reports[s.code], t));
  } catch (e) { return say(chat, "⚠️ " + h(e.message), { reply_markup: menuMarkup(t) }); }
}
async function replyText(chat, s, t, text) {
  if (s.step === "text") {
    if (text.trim().length < 5) return say(chat, "Javob matni kamida 5 ta belgidan iborat boʻlsin.");
    s.text = text.trim().slice(0, 800); s.step = "org";
    return say(chat, "🏢 Masʼul tashkilot nomini yozing yoki oʻtkazib yuboring.", { reply_markup: ik([[btn("⏭ Oʻtkazib yuborish", "rp:skip")]]) });
  }
  return finishReply(chat, s, t, text.trim().slice(0, 80));
}

async function modCallback(cq, t, parts) {
  const mod = svc.tgModerator(t);
  if (!mod) return answer(cq, "Bu amal faqat moderatorlar uchun. Saytda hisobingizga kirib, botga ulang (/link).", true);
  const code = parts[1], letter = parts[2], r = store.db.reports[code];
  if (!r) return answer(cq, "Murojaat topilmadi. U oʻchirilgan boʻlishi mumkin.", true);
  if (letter === "h" || letter === "r") {
    try { await api("sendChatAction", { chat_id: t.chatId, action: "typing" }); } catch (e) { return answer(cq, "Avval botga shaxsiy xabarda /start yuboring, keyin qayta urining.", true); }
    await answer(cq, "Javob matnini shaxsiy chatda yozing.");
    return startReply(t.chatId, t, code, letter === "h" ? "hal" : "rad");
  }
  const status = letter === "k" ? "korib" : "yangi";
  const prev = store.db.responses[code] || {};
  try { svc.setResponse(code, { status, org: prev.org || "", text: prev.text || "" }, actorFor(mod, cq.from)); }
  catch (e) { return answer(cq, e.message, true); }
  await answer(cq, "Holat: " + C.STATUS[status].label);
  const card = cardFor(store.db.reports[code], t);
  const msg = cq.message;
  return api(msg.photo ? "editMessageCaption" : "editMessageText", Object.assign({ chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: "HTML", reply_markup: card.markup }, msg.photo ? { caption: card.text } : { text: card.text, disable_web_page_preview: true }))
    .catch(e => { if (!/not modified/i.test(e.message)) logErr("edit", e); });
}

/* ---------- commands ---------- */
function helpText(t) {
  const L = ["🌳 <b>Yashil Toshkent</b> — daraxt va yashil hudud muammolari xaritasi.", "",
    "Bot saytdagi bilan bir xil ishlaydi: bu yerda yuborilgan murojaat saytda, saytdagisi esa bu yerda koʻrinadi.", "",
    "📝 /yangi — yangi murojaat yuborish", "📋 /royxat — barcha murojaatlar", "📂 /mening — mening murojaatlarim",
    "🔎 /qidirish — raqam boʻyicha (yoki shunchaki <code>TD-XXXXXX</code> yozing)", "🔔 /obuna — yangi murojaatlar haqida xabar olish (yoqish/oʻchirish)",
    "🔗 /link KOD — sayt hisobini ulash (saytda «Telegram» tugmasidan kod oling)", "❌ /bekor — joriy amalni bekor qilish"];
  if (svc.tgModerator(t)) L.push("", "🛠 <b>Moderator:</b> /stat — statistika; murojaat kartochkasidagi tugmalar bilan holatni oʻzgartiring yoki javob yozing.");
  const su = siteUrl(); if (su) L.push("", "🌐 Sayt: " + su);
  return L.join("\n");
}

async function sendStat(chat, t) {
  const o = svc.overview();
  return say(chat, "📊 <b>Statistika</b>\n\nJami: <b>" + o.reports + "</b> · hal etilmagan: <b>" + o.open + "</b> · ⚠️ shoshilinch: <b>" + o.urgent + "</b>\nBugun: " + o.today + " · 7 kunda: " + o.week +
    "\n\n🔵 Yangi: " + o.byStatus.yangi + "\n🟡 Koʻrib chiqilmoqda: " + o.byStatus.korib + "\n✅ Hal qilindi: " + o.byStatus.hal + "\n⛔ Rad etildi: " + o.byStatus.rad +
    "\n\nSayt: " + o.byVia.web + " · Telegram: " + o.byVia.telegram, { reply_markup: ik([[btn("Hal etilmaganlar", "l:open:0"), btn("⚠️ Shoshilinch", "l:urg:0")]]) });
}

async function viewCode(chat, t, raw) {
  const code = String(raw || "").trim().toUpperCase();
  if (!/^TD-[A-Z0-9]{4,10}$/.test(code)) return say(chat, "Murojaat raqami <code>TD-XXXXXX</code> koʻrinishida boʻlsin.");
  const r = store.db.reports[code];
  if (!r) return say(chat, "<code>" + h(code) + "</code> raqamli murojaat topilmadi. U oʻchirilgan boʻlishi mumkin.");
  return sendCard(chat, r, cardFor(r, t));
}

const ALIAS = {
  start: ["start"], help: ["yordam", "help"], new: ["yangi", "new"], list: ["royxat", "list"], mine: ["mening", "my"], find: ["qidirish", "find"],
  sub: ["obuna", "subscribe"], link: ["link", "ulash"], unlink: ["unlink", "uzish"], cancel: ["bekor", "cancel"], stat: ["stat"]
};
function commandOf(name) { for (const k in ALIAS) if (ALIAS[k].indexOf(name) >= 0) return k; return null; }

async function runCommand(cmd, arg, chat, t, m) {
  switch (cmd) {
    case "start": {
      if (/^link_/i.test(arg || "")) return runCommand("link", arg.slice(5), chat, t, m);
      await say(chat, "Assalomu alaykum, <b>" + h(t.name || "doʻst") + "</b>! 👋\n\n" + helpText(t), { reply_markup: menuMarkup(t) });
      return;
    }
    case "help": return say(chat, helpText(t), { reply_markup: menuMarkup(t) });
    case "new": return startNew(chat, t);
    case "list": { const p = listPage("all", 0, t); return say(chat, p.text, { reply_markup: p.markup }); }
    case "mine": { const p = listPage("mine", 0, t); return say(chat, mineList(t).length ? p.text : "Siz hali murojaat yubormagansiz. 📝 «Yangi murojaat» tugmasini bosing." + (t.userId ? "" : "\n\n<i>Saytdan yuborgan murojaatlaringiz bu yerda koʻrinishi uchun hisobingizni ulang: /link</i>"), { reply_markup: p.markup }); }
    case "find": sessions.set(chat, { flow: "find", ts: Date.now() }); return say(chat, "🔎 Murojaat raqamini yozing (masalan <code>TD-AB12CD</code>):", { reply_markup: { keyboard: [[{ text: BTN.cancel }]], resize_keyboard: true } });
    case "sub": {
      t.notifyNew = !t.notifyNew; store.bump("tg");
      return say(chat, t.notifyNew ? "🔔 Yoqildi: har bir yangi murojaat haqida shu yerda xabar olasiz." : "🔕 Oʻchirildi: yangi murojaatlar haqida xabar yuborilmaydi.", { reply_markup: menuMarkup(t) });
    }
    case "link": {
      if (!arg) return say(chat, "Saytga kiring → «Telegram» tugmasi → kodni oling, soʻng yuboring: <code>/link KOD</code>");
      try {
        const u = svc.linkTelegram(t, arg);
        return say(chat, "✅ Hisob ulandi: <b>" + h(u.name) + "</b> (" + h(u.login) + ", " + C.ROLE_LABEL[u.role] + ")." + (svc.isMod(u) ? "\nYangi murojaatlar haqida xabar olasiz va holatni shu yerdan oʻzgartira olasiz." : "\nSaytdan yuborgan murojaatlaringiz endi «📂 Mening murojaatlarim»da koʻrinadi."), { reply_markup: menuMarkup(t) });
      } catch (e) { return say(chat, "⚠️ " + h(e.message)); }
    }
    case "unlink": {
      const u = t.userId && auth.findById(t.userId);
      if (!u) return say(chat, "Hisob ulanmagan.");
      svc.unlinkTelegramByUser(u);
      return say(chat, "Hisob uzildi.", { reply_markup: menuMarkup(t) });
    }
    case "cancel": sessions.delete(chat); return say(chat, "Bekor qilindi.", { reply_markup: menuMarkup(t) });
    case "stat": if (!svc.tgModerator(t)) return say(chat, "Bu boʻlim faqat moderatorlar uchun."); return sendStat(chat, t);
  }
}

async function onPrivateMessage(m) {
  const chat = m.chat.id, t = svc.upsertTgUser(m.from, chat);
  if (t.blocked) return;
  let text = (m.text || "").trim();
  // menu buttons
  if (text === BTN.cancel) return runCommand("cancel", "", chat, t, m);
  const cm = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  let cmd = null, arg = "";
  if (cm) { cmd = commandOf(cm[1].toLowerCase()); arg = (cm[2] || "").trim(); if (!cmd) return say(chat, "Nomaʼlum buyruq. /yordam", { reply_markup: menuMarkup(t) }); }
  else if (text === BTN.new) cmd = "new";
  else if (text === BTN.list) cmd = "list";
  else if (text === BTN.mine) cmd = "mine";
  else if (text === BTN.find) cmd = "find";
  else if (text === BTN.help) cmd = "help";
  else if (text === BTN.mod) { if (!svc.tgModerator(t)) return say(chat, "Bu boʻlim faqat moderatorlar uchun. Hisobni ulash: /link"); cmd = "stat"; }
  if (cmd) { if (cmd !== "id") sessions.delete(chat); return runCommand(cmd, arg, chat, t, m); }

  const s = sessions.get(chat);
  if (s && Date.now() - s.ts > 30 * 60e3) { sessions.delete(chat); }
  const live = sessions.get(chat);
  if (live) {
    live.ts = Date.now();
    if (live.flow === "new") {
      const loc = m.location || (m.venue && m.venue.location);
      if (m.contact) return newContact(chat, live, t, m);
      if (loc && live.step === "phone") return say(chat, "Avval telefon raqamingizni yuboring: pastdagi «" + BTN.phone + "» tugmasi.", { reply_markup: phoneKeyboard });
      if (loc) { if (live.step !== "loc") return say(chat, "Joylashuv allaqachon belgilangan. Oʻzgartirish uchun «🔄 Boshqa joy» tugmasini bosing."); return resolveLocation(chat, live, t, loc.latitude, loc.longitude, loc.horizontal_accuracy, null); }
      if (m.photo) return newPhoto(chat, live, t, m);
      if (text) return newText(chat, live, t, text);
      return;
    }
    if (live.flow === "reply" && text) return replyText(chat, live, t, text);
    if (live.flow === "find" && text) { sessions.delete(chat); return viewCode(chat, t, text).then(() => say(chat, "Yana qidirish: /qidirish", { reply_markup: menuMarkup(t) })); }
    return;
  }
  const loc = m.location || (m.venue && m.venue.location);
  if (loc) { const ns = { flow: "new", step: "loc", d: {}, ts: Date.now() }; sessions.set(chat, ns); return resolveLocation(chat, ns, t, loc.latitude, loc.longitude, loc.horizontal_accuracy, null); }
  if (m.contact) return say(chat, "Telefon raqami faqat «📝 Yangi murojaat» jarayonida soʻraladi.", { reply_markup: menuMarkup(t) });
  if (/^TD-[A-Z0-9]{4,10}$/i.test(text)) return viewCode(chat, t, text);
  return say(chat, "Tushunmadim. Menyudan tanlang yoki /yordam.", { reply_markup: menuMarkup(t) });
}

async function onMessage(m) {
  if (!m.from || m.from.is_bot) return;
  if (m.chat.type !== "private") {
    const cm = /^\/id(?:@(\w+))?\b/i.exec(m.text || "");
    if (cm && (!cm[1] || (me && cm[1].toLowerCase() === me.username.toLowerCase())))
      return say(m.chat.id, "Chat ID: <code>" + m.chat.id + "</code>\nBuni super admin sahifasida «Bildirishnoma chati» maydoniga kiriting.");
    return;
  }
  if (/^\/id\b/i.test(m.text || "")) return say(m.chat.id, "Sizning Telegram ID: <code>" + m.from.id + "</code>\nChat ID: <code>" + m.chat.id + "</code>");
  return onPrivateMessage(m);
}

async function onCallback(cq) {
  const msg = cq.message, data = cq.data || "";
  if (!msg) return answer(cq);
  const priv = msg.chat.type === "private";
  const t = priv ? svc.upsertTgUser(cq.from, msg.chat.id) : store.db.tgUsers[String(cq.from.id)];
  if (t && t.blocked) return answer(cq);
  const parts = data.split(":");
  if (data === "noop") return answer(cq);
  if (parts[0] === "m") { if (!t) return answer(cq, "Avval botga shaxsiy xabarda /start yuboring va hisobingizni ulang (/link).", true); return modCallback(cq, t, parts); }
  if (!t) return answer(cq, "Botga shaxsiy xabarda /start yuboring.", true);
  if (parts[0] === "n") { if (!priv) return answer(cq); return newCallback(cq, msg.chat.id, t, parts); }
  if (parts[0] === "l") {
    const p = listPage(parts[1], +parts[2] || 0, t);
    await answer(cq);
    return api("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: p.text, parse_mode: "HTML", reply_markup: p.markup }).catch(e => { if (!/not modified/i.test(e.message)) logErr("list", e); });
  }
  if (parts[0] === "v") { await answer(cq); return viewCode(msg.chat.id, t, parts[1]); }
  if (parts[0] === "r") {
    if (!svc.tgModerator(t)) return answer(cq, "Bu amal faqat moderatorlar uchun.", true);
    const r = store.db.reports[parts[1]]; if (!r) return answer(cq, "Murojaat topilmadi.", true);
    try { await api("sendChatAction", { chat_id: t.chatId, action: "typing" }); } catch (e) { return answer(cq, "Avval botga shaxsiy xabarda /start yuboring.", true); }
    await answer(cq, "Javob matnini shaxsiy chatda yozing.");
    const cur = svc.statusOf(r.code);
    return startReply(t.chatId, t, r.code, cur === "yangi" ? "korib" : cur);
  }
  if (data === "rp:skip") {
    const s = sessions.get(msg.chat.id);
    if (!s || s.flow !== "reply" || s.step !== "org") return answer(cq, "Bu tugma eskirgan.", true);
    await answer(cq); return finishReply(msg.chat.id, s, t, "");
  }
  return answer(cq);
}

async function onUpdate(u) {
  try {
    if (u.message) await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
  } catch (e) { logErr("update " + u.update_id, e); }
}

/* ---------- push notifications (site <-> bot sync) ---------- */
store.bus.on("report:new", r => { if (looping) notifyNew(r).catch(e => logErr("notifyNew", e)); });
store.bus.on("response", ev => { if (looping) notifyResponse(ev).catch(e => logErr("notifyResponse", e)); });

async function notifyNew(r) {
  const header = "🆕 <b>Yangi murojaat</b> (" + (r.via === "telegram" ? "Telegram bot" : "sayt") + " orqali)";
  const sent = new Set();
  for (const t of Object.values(store.db.tgUsers)) {
    if (!t.notifyNew || t.blocked || t.id === r.tgId) continue;
    sent.add(String(t.chatId));
    await sendCard(t.chatId, r, cardFor(r, t, header));
  }
  const g = store.db.settings.notifyChatId;
  if (g && !sent.has(String(g))) await sendCard(g, r, renderReport(r, { mod: true, header, photo: !!r.hasPhoto }));
}

async function notifyResponse({ report: r, response: rs, prev, actor }) {
  if (prev && prev.status === rs.status && prev.text === rs.text && prev.org === rs.org) return;
  const targets = new Map();
  const t1 = r.tgId && store.db.tgUsers[r.tgId]; if (t1) targets.set(t1.id, t1);
  const au = r.authorId && auth.findById(r.authorId); const t2 = au && au.telegramId && store.db.tgUsers[String(au.telegramId)]; if (t2) targets.set(t2.id, t2);
  const s = C.STATUS[rs.status], ty = C.TYPES[r.type] || C.TYPES.zarar;
  for (const t of targets.values()) {
    if (t.blocked || (actor && actor.tgId && actor.tgId === t.id)) continue;
    await say(t.chatId, "📣 <b>Murojaatingiz yangilandi</b>\n" + ty.emoji + " " + h(ty.label) + " · <code>" + r.code + "</code>\n" + s.emoji + " Holat: <b>" + h(s.label) + "</b>" +
      (rs.org ? "\n🏢 Masʼul: " + h(rs.org) : "") + (rs.text ? "\n\n💬 " + h(rs.text) : ""), { reply_markup: ik([[btn("📄 Koʻrish", "v:" + r.code)]]) });
  }
  const g = store.db.settings.notifyChatId;
  if (g && !(actor && actor.via === "telegram")) await say(g, "ℹ️ <code>" + r.code + "</code> → " + s.emoji + " " + h(s.label) + (actor && actor.name ? " (" + h(actor.name) + ", sayt)" : ""));
}

/* ---------- lifecycle ---------- */
function status() { return { configured: !!cfg.BOT_TOKEN, running: looping && !!me, username: me ? me.username : "", lastError, startedAt }; }

async function testNotify() {
  const chat = store.db.settings.notifyChatId;
  if (!cfg.BOT_TOKEN) throw E(400, "bot", "Bot sozlanmagan (TELEGRAM_BOT_TOKEN yoʻq).");
  if (!looping) throw E(400, "bot", "Bot hozir ishlamayapti" + (lastError ? ": " + lastError : "."));
  if (!chat) throw E(400, "chat", "Avval bildirishnoma chatini kiriting va saqlang.");
  try { await api("sendMessage", { chat_id: chat, text: "✅ Test xabar: Yashil Toshkent boti shu chatga yangi murojaatlarni yuboradi." }); }
  catch (e) { throw E(502, "bot", "Yuborib boʻlmadi: " + e.message.replace(/^Telegram \w+: /, "") + ". Bot chatga qoʻshilganini tekshiring."); }
  return { ok: true };
}

async function loop() {
  let offset = store.db.tgOffset || 0;
  while (looping) {
    try {
      const ups = await tg.call("getUpdates", { offset, timeout: 40, allowed_updates: ["message", "callback_query"] }, null, 55000);
      lastError = "";
      if (ups.length) {
        for (const u of ups) { offset = u.update_id + 1; await onUpdate(u); }
        store.db.tgOffset = offset; store.save();
      }
    } catch (e) {
      lastError = e.message;
      if (e.code === 401) { console.error("[bot] Token notoʻgʻri — bot toʻxtatildi."); looping = false; return; }
      if (e.code === 409) { console.error("[bot] 409: bu token bilan boshqa nusxa ishlayapti (yoki webhook oʻrnatilgan)."); await sleep(8000); continue; }
      await sleep(e.retryAfter ? e.retryAfter * 1000 : 3000);
    }
  }
}

async function start() {
  if (!cfg.BOT_TOKEN) { console.log("Telegram bot: TELEGRAM_BOT_TOKEN koʻrsatilmagan — bot oʻchirilgan (sayt ishlayveradi)."); return; }
  startedAt = Date.now();
  for (;;) {
    try { me = await tg.call("getMe"); break; }
    catch (e) {
      lastError = e.message;
      if (e.code === 401) { console.error("[bot] Token notoʻgʻri. @BotFather dagi tokenni tekshiring."); return; }
      console.error("[bot] Telegramga ulanib boʻlmadi (" + e.message + "). 10 soniyadan keyin qayta uriniladi."); await sleep(10000);
    }
  }
  console.log("Telegram bot: @" + me.username + " ishga tushdi");
  await tg.call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
  await tg.call("setMyCommands", { commands: [
    { command: "yangi", description: "Yangi murojaat yuborish" }, { command: "royxat", description: "Barcha murojaatlar" },
    { command: "mening", description: "Mening murojaatlarim" }, { command: "qidirish", description: "Raqam boʻyicha qidirish" },
    { command: "obuna", description: "Yangi murojaatlar haqida xabar" }, { command: "link", description: "Sayt hisobini ulash" },
    { command: "yordam", description: "Yordam" }, { command: "bekor", description: "Bekor qilish" }
  ] }).catch(() => {});
  looping = true;
  setInterval(() => { const now = Date.now(); sessions.forEach((s, k) => { if (now - s.ts > 30 * 60e3) sessions.delete(k); }); }, 5 * 60e3).unref();
  loop();
}

module.exports = { start, status, testNotify, _test: { renderReport, listPage, onUpdate } };
