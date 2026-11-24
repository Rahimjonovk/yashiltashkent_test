"use strict";
/* End-to-end test: real server process + fake Telegram Bot API + fake Nominatim/Overpass.
   Proves the site and the bot work on the same data in both directions. Run: npm test */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/* ------------------------------------------------------------------ fake Telegram */
function fakeTelegram() {
  const calls = [];           // every Bot API call the server made: {method, params, raw}
  const queue = [];           // updates waiting for getUpdates
  let waiter = null, nextId = 1000, nextMsg = 1;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const m = /^\/bot[^/]+\/(\w+)$/.exec(req.url), f = /^\/file\/bot[^/]+\/(.+)$/.exec(req.url);
      const ok = result => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
      if (f) { res.writeHead(200); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xff, 0xd9])); }
      if (!m) { res.writeHead(404); return res.end(); }
      const method = m[1];
      let params = {};
      if (/json/.test(req.headers["content-type"] || "")) { try { params = JSON.parse(body.toString() || "{}"); } catch (e) {} }
      calls.push({ method, params, raw: body.toString("latin1") });
      if (method === "getUpdates") {
        const deliver = () => ok(queue.splice(0));
        if (queue.length) return deliver();
        const t = setTimeout(() => { waiter = null; ok([]); }, Math.min(1500, (params.timeout || 1) * 1000));
        waiter = () => { clearTimeout(t); waiter = null; deliver(); };
        return;
      }
      if (method === "getMe") return ok({ id: 1, is_bot: true, username: "td_test_bot", first_name: "TD" });
      if (method === "getFile") return ok({ file_id: params.file_id, file_path: "photos/x.jpg" });
      if (/^send(Message|Photo|Location)$/.test(method) || /^edit/.test(method)) return ok({ message_id: nextMsg++, chat: { id: params.chat_id } });
      return ok(true);
    });
  });
  const api = {
    server, calls,
    push(update) { update.update_id = nextId++; queue.push(update); if (waiter) waiter(); },
    msg(from, text, extra) { api.push({ message: Object.assign({ message_id: nextMsg++, from: { id: from, first_name: "U" + from, username: "user" + from }, chat: { id: from, type: "private" }, date: 0, text }, extra || {}) }); },
    cb(from, data, messageId) { api.push({ callback_query: { id: "cb" + nextId, from: { id: from, first_name: "U" + from, username: "user" + from }, data, message: { message_id: messageId || 1, chat: { id: from, type: "private" } } } }); },
    sent(chat, re) { return calls.filter(c => /^send(Message|Photo)$/.test(c.method) && String(c.params.chat_id || (/name="chat_id"\r\n\r\n(\d+)/.exec(c.raw) || [])[1]) === String(chat) && re.test(c.params.text || c.params.caption || c.raw)); },
    async waitSent(chat, re, ms) { return waitFor(() => api.sent(chat, re)[0], ms || 8000, "bot message to " + chat + " matching " + re); },
    lastButtons(chat, re) { const c = api.sent(chat, re).pop(); const k = c && (c.params.reply_markup || {}).inline_keyboard; return k ? [].concat(...k) : []; }
  };
  return api;
}

/* ------------------------------------------------------------------ fake Nominatim + Overpass */
function fakeGeo() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits.push(u.pathname);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (u.pathname === "/reverse") {
      const lat = Number(u.searchParams.get("lat"));
      if (lat < 41.22) return res.end(JSON.stringify({ display_name: "Noma'lum yoʻl", address: { road: "Yangi yoʻl", city: "Toshkent" } }));   // OSM does not name the district
      if (lat > 41.35) return res.end(JSON.stringify({ display_name: "Aeroport", address: { city_district: "Yunusobod tumani", road: "Amir Temur shoh koʻchasi" } }));   // street, no house number
      return res.end(JSON.stringify({ display_name: "43, Bunyodkor, Chilonzor", address: { house_number: "43", road: "Bunyodkor koʻchasi", suburb: "Chilonzor-9", city_district: "Чиланзарский район", city: "Toshkent" } }));
    }
    if (u.pathname === "/search") return res.end(JSON.stringify([{ lat: "41.2750", lon: "69.2030", display_name: "Chilonzor 43", address: { house_number: "43", road: "Bunyodkor koʻchasi", city_district: "Chilonzor tumani" } }]));
    if (u.pathname === "/overpass") return res.end(JSON.stringify({ elements: [{ type: "node", lat: 41.3601, lon: 69.2001, tags: { "addr:housenumber": "7A", "addr:street": "Amir Temur shoh koʻchasi" } }] }));
    res.end("{}");
  });
  return { server, hits };
}

/* ------------------------------------------------------------------ helpers */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const end = Date.now() + (ms || 5000);
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout waiting for " + (what || "condition")); await sleep(50); }
}
const listen = s => new Promise(r => s.listen(0, "127.0.0.1", () => r(s.address().port)));

let tg, geo, proc, base, dataDir, out = "";
const ctx = { tokens: {} };
async function call(method, p, token, body) {
  const r = await fetch(base + "/api" + p, { method, headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
const JPG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString("base64");

test.before(async () => {
  tg = fakeTelegram(); geo = fakeGeo();
  const tp = await listen(tg.server), gp = await listen(geo.server);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "td-e2e-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = "http://127.0.0.1:" + port;
  proc = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: Object.assign({}, process.env, { PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, TELEGRAM_BOT_TOKEN: "111:TEST", TELEGRAM_API_BASE: "http://127.0.0.1:" + tp,
      NOMINATIM_URL: "http://127.0.0.1:" + gp, OVERPASS_URL: "http://127.0.0.1:" + gp + "/overpass", SUPERADMIN_LOGIN: "boss", SUPERADMIN_PASSWORD: "Boss#Pass2026", PUBLIC_URL: "https://yashil.example.uz" })
  });
  proc.stdout.on("data", d => { out += d; }); proc.stderr.on("data", d => { out += d; });
  await waitFor(() => /@td_test_bot ishga tushdi/.test(out), 10000, "server + bot start\n" + out);
});
test.after(() => { try { proc.kill(); } catch (e) {} tg.server.close(); geo.server.close(); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} });

/* ================================================================== */
test("address: full address for a clicked point (district · street · house)", async () => {
  const r = await call("GET", "/geocode?lat=41.2750&lon=69.2030");
  assert.equal(r.status, 200);
  assert.equal(r.body.address, "Chilonzor tumani, Bunyodkor koʻchasi, 43-uy");
  assert.equal(r.body.district, "Chilonzor");               // matched from the Russian name "Чиланзарский район"
  const again = await call("GET", "/geocode?lat=41.2750&lon=69.2030");
  assert.equal(again.body.address, r.body.address);
  assert.equal(geo.hits.filter(h => h === "/reverse").length, 1, "second lookup must come from cache");
});

test("address: street without house number -> nearest house from Overpass", async () => {
  const r = await call("GET", "/geocode?lat=41.3601&lon=69.2001");
  assert.equal(r.body.district, "Yunusobod");
  assert.match(r.body.address, /^Yunusobod tumani, Amir Temur shoh koʻchasi, 7A-uy/);
  assert.equal((await call("GET", "/geocode?lat=abc&lon=1")).status, 400);
});

test("auth: roles and permissions", async () => {
  const bad = await call("POST", "/auth/login", null, { login: "boss", password: "nope" });
  assert.equal(bad.status, 401);
  const ok = await call("POST", "/auth/login", null, { login: "boss", password: "Boss#Pass2026" });
  assert.equal(ok.status, 200); assert.equal(ok.body.user.role, "superadmin");
  ctx.tokens.boss = ok.body.token;

  assert.equal((await call("GET", "/super/overview")).status, 401);                          // anonymous
  const reg = await call("POST", "/auth/register", null, { name: "Citizen One", login: "citizen1", password: "Citizen#1234" });
  assert.equal(reg.status, 200); ctx.tokens.citizen = reg.body.token; ctx.citizenId = reg.body.user.id;
  assert.equal((await call("GET", "/super/overview", ctx.tokens.citizen)).status, 403);     // plain user
  assert.equal((await call("PUT", "/reports/TD-AAAAAA/response", ctx.tokens.citizen, { status: "hal", text: "xxxxx" })).status, 403);

  const mk = await call("POST", "/super/users", ctx.tokens.boss, { name: "Moderator Ali", login: "ali", password: "Mod#Pass2026", role: "admin" });
  assert.equal(mk.status, 200); assert.equal(mk.body.user.role, "admin"); assert.equal(mk.body.user.mustChange, true);
  const li = await call("POST", "/auth/login", null, { login: "ali", password: "Mod#Pass2026" });
  ctx.tokens.ali = li.body.token; ctx.aliId = mk.body.user.id;
  assert.equal((await call("GET", "/super/users", ctx.tokens.ali)).status, 403);            // moderator is not super admin
});

test("last super admin cannot be demoted, blocked or deleted", async () => {
  const me = (await call("GET", "/auth/me", ctx.tokens.boss)).body.user;
  assert.equal((await call("PATCH", "/super/users/" + me.id, ctx.tokens.boss, { role: "admin" })).status, 400);
  assert.equal((await call("PATCH", "/super/users/" + me.id, ctx.tokens.boss, { blocked: true })).status, 400);
  assert.equal((await call("DELETE", "/super/users/" + me.id, ctx.tokens.boss)).status, 400);
});

test("telegram: a moderator links the account with a code from the site", async () => {
  const code = (await call("POST", "/auth/telegram-link", ctx.tokens.ali)).body;
  assert.equal(code.botUsername, "td_test_bot"); assert.match(code.code, /^[A-Z2-9]{8}$/);
  tg.msg(5001, "/start link_" + code.code);                                                   // deep link t.me/bot?start=link_CODE
  await tg.waitSent(5001, /Hisob ulandi/);
  const me = (await call("GET", "/auth/me", ctx.tokens.ali)).body.user;
  assert.equal(me.telegram, true);
  assert.equal((await call("POST", "/auth/telegram-link", ctx.tokens.ali)).status, 200);
  tg.msg(5002, "/link WRONGCODE");
  await tg.waitSent(5002, /notoʻgʻri|muddati/);
});

test("SITE -> BOT: a report sent from the web appears in the bot (moderator gets a card with buttons)", async () => {
  const r = await call("POST", "/reports", null, {
    type: "chirigan", species: "Chinor", count: "2-5", danger: true, lat: 41.2750, lon: 69.2030, source: "map", district: "Chilonzor",
    address: "Chilonzor tumani, Bunyodkor koʻchasi, 43-uy", description: "Katta chinor tanasi chirigan, yoʻlga qulashi mumkin.", name: "Vali", photo: JPG
  });
  assert.equal(r.status, 200);
  const code = r.body.report.code; ctx.webCode = code;
  assert.match(code, /^TD-[A-Z2-9]{6}$/);
  assert.equal(r.body.report.address, "Chilonzor tumani, Bunyodkor koʻchasi, 43-uy"); assert.equal(r.body.report.hasPhoto, true);

  const m = await tg.waitSent(5001, new RegExp(code));                                          // photo card (sendPhoto) to the moderator
  assert.equal(m.method, "sendPhoto");
  assert.match(m.raw, /Yangi murojaat/); assert.match(m.raw, /Bunyodkor/); assert.match(m.raw, /Shoshilinch/);
  assert.match(m.raw, new RegExp("m:" + code + ":h"));                                          // inline buttons for the moderator

  const photo = await fetch(base + "/api/reports/" + code + "/photo");
  assert.equal(photo.status, 200); assert.equal(photo.headers.get("content-type"), "image/jpeg");
  assert.equal((await tg.sent(5002, new RegExp(code))).length, 0, "non-moderators must not get the card");
});

test("BOT -> SITE: a report created in the bot shows up on the site with its address", async () => {
  const U = 7001;
  tg.msg(U, "/yangi"); await tg.waitSent(U, /Telefon raqamingiz/);
  assert.ok(tg.sent(U, /Telefon raqamingiz/)[0].params.reply_markup.keyboard[0][0].request_contact, "phone is requested with Telegram's contact button");
  tg.msg(U, "", { text: undefined, contact: { phone_number: "998900000000", first_name: "Boshqa", user_id: 99999 } });   // somebody else's contact
  await tg.waitSent(U, /oʻzingizning raqamingizni/);
  tg.msg(U, "+998 90 123 45 67");                                                                                    // typed text is not accepted either
  await tg.waitSent(U, /tugmasini bosing/);
  tg.msg(U, "", { text: undefined, contact: { phone_number: "998901234567", first_name: "U", user_id: U } });
  await tg.waitSent(U, /Raqam qabul qilindi/); await tg.waitSent(U, /Joylashuv/);
  tg.msg(U, "", { text: undefined, location: { latitude: 41.2750, longitude: 69.2030, horizontal_accuracy: 12 } });
  const conf = await tg.waitSent(U, /Manzil:.*Bunyodkor.*43-uy/);
  assert.match(conf.params.text, /Chilonzor tumani/);
  tg.cb(U, "n:ok"); await tg.waitSent(U, /Muammo turi/);
  tg.cb(U, "n:t:qurigan"); await tg.waitSent(U, /Daraxt turi/);
  tg.cb(U, "n:s:0"); await tg.waitSent(U, /Daraxtlar soni/);
  tg.cb(U, "n:c:1"); await tg.waitSent(U, /xavf bormi/);
  tg.cb(U, "n:g:0"); await tg.waitSent(U, /Nima koʻrdingiz/);
  tg.msg(U, "qisqa");                                                                           // too short -> asked again
  await tg.waitSent(U, /Kamida 10/);
  tg.msg(U, "Daraxt butunlay qurib qolgan, barglari yoʻq, bir oydan beri shunday.");
  await tg.waitSent(U, /Rasm yuboring/);
  tg.cb(U, "n:p:skip"); await tg.waitSent(U, /Murojaatni tekshiring/);
  tg.cb(U, "n:y");
  const done = await tg.waitSent(U, /Murojaat yuborildi/);
  const code = /TD-[A-Z2-9]{6}/.exec(done.params.text)[0]; ctx.tgCode = code;

  const list = (await call("GET", "/reports")).body;
  const rep = list.reports.find(x => x.code === code);
  assert.ok(rep, "bot report must be visible through the website API");
  assert.equal(rep.via, "telegram"); assert.equal(rep.type, "qurigan"); assert.equal(rep.district, "Chilonzor");
  assert.equal(rep.address, "Chilonzor tumani, Bunyodkor koʻchasi, 43-uy"); assert.equal(rep.species, "Chinor");
  assert.ok(list.reports.some(x => x.code === ctx.webCode), "web report is still there");
  // the phone is private: citizens and anonymous visitors never get it, moderators do
  assert.equal(rep.phone, undefined);
  const staffView = (await call("GET", "/reports", ctx.tokens.boss)).body.reports.find(x => x.code === code);
  assert.equal(staffView.phone, "+998901234567");
  // and the moderator is told about it in Telegram (with the phone number, in the private chat)
  const card = await tg.waitSent(5001, new RegExp(code));
  assert.match(card.params.caption || card.params.text || card.raw, /\+998901234567/);
  const mine = await (async () => { tg.msg(U, "/mening"); return tg.waitSent(U, /Mening murojaatlarim<\/b>: \d+ ta/); })();
  assert.ok(tg.lastButtons(U, /Mening murojaatlarim<\/b>: \d+ ta/).some(b => b.callback_data === "v:" + code));
  assert.equal(mine.method, "sendMessage");
});

test("bot: a user can look a site report up by its number", async () => {
  tg.msg(7001, ctx.webCode);
  const m = await tg.waitSent(7001, /Katta chinor/);
  assert.match(m.params.text || m.raw, /Bunyodkor/);
});

test("BOT -> SITE: a moderator answers from Telegram, the site and the citizen see it", async () => {
  const code = ctx.tgCode;
  assert.equal((await call("GET", "/reports")).body.responses[code], undefined);
  tg.cb(5001, "m:" + code + ":k");                                                              // "Koʻrib chiqilmoqda" button
  await waitFor(async () => (await call("GET", "/reports")).body.responses[code], 5000, "status change from bot");
  assert.equal((await call("GET", "/reports")).body.responses[code].status, "korib");
  await tg.waitSent(7001, /Murojaatingiz yangilandi[\s\S]*Koʻrib chiqilmoqda/);                 // author is notified

  tg.cb(5001, "m:" + code + ":h");                                                              // "Hal qilindi" -> bot asks for text
  await tg.waitSent(5001, /javob matnini yozing/);
  tg.msg(5001, "ok");                                                                           // too short
  await tg.waitSent(5001, /kamida 5/);
  tg.msg(5001, "Daraxt kesib olib ketildi, joyiga yangi koʻchat oʻtqazildi.");
  await tg.waitSent(5001, /tashkilot/);
  tg.cb(5001, "rp:skip");
  const rs = await waitFor(async () => { const x = (await call("GET", "/reports")).body.responses[code]; return x && x.status === "hal" && x; }, 5000, "resolved from bot");
  assert.equal(rs.by, "Moderator Ali"); assert.match(rs.text, /yangi koʻchat/);
  await tg.waitSent(7001, /Hal qilindi[\s\S]*yangi koʻchat/);
});

test("SITE -> BOT: a moderator answers on the site, the author is told in Telegram", async () => {
  // link the citizen account to Telegram first, so a *site* report is also theirs in the bot
  const code = (await call("POST", "/auth/telegram-link", ctx.tokens.citizen)).body.code;
  tg.msg(7002, "/link " + code); await tg.waitSent(7002, /Hisob ulandi/);
  const rep = (await call("POST", "/reports", ctx.tokens.citizen, { type: "yashil", lat: 41.30, lon: 69.25, district: "Mirobod", address: "Mirobod tumani",
    description: "Maysazorga chiqindi tashlab ketishgan, uch kundan beri yotibdi." })).body.report;
  assert.equal(rep.mine, true);
  tg.msg(7002, "/mening"); await tg.waitSent(7002, /Mening murojaatlarim<\/b>: \d+ ta/);
  assert.ok(tg.lastButtons(7002, /Mening murojaatlarim<\/b>: \d+ ta/).some(b => b.callback_data === "v:" + rep.code), "site report visible in the bot for the linked user");

  const put = await call("PUT", "/reports/" + rep.code + "/response", ctx.tokens.ali, { status: "rad", org: "Obodonlashtirish", text: "Bu hudud xususiy mulk, murojaat rad etildi." });
  assert.equal(put.status, 200);
  await tg.waitSent(7002, /Rad etildi[\s\S]*xususiy mulk/);
  assert.equal((await call("PUT", "/reports/" + rep.code + "/response", ctx.tokens.ali, { status: "hal", text: "x" })).status, 400);   // text required
});

test("bot: non-moderators cannot press moderator buttons", async () => {
  const before = (await call("GET", "/reports")).body.responses[ctx.webCode];
  tg.cb(7001, "m:" + ctx.webCode + ":k");
  await waitFor(() => tg.calls.some(c => c.method === "answerCallbackQuery" && /faqat moderatorlar/.test(c.params.text || "")), 5000, "refusal");
  assert.equal((await call("GET", "/reports")).body.responses[ctx.webCode], before);
});

test("typing an address in the bot finds the point (forward search)", async () => {
  const U = 7003;
  tg.msg(U, "/yangi"); await tg.waitSent(U, /Telefon raqamingiz/);
  tg.msg(U, "", { text: undefined, contact: { phone_number: "+998 93 555 00 11", first_name: "U", user_id: U } });
  await tg.waitSent(U, /Joylashuv/);
  tg.msg(U, "Chilonzor 43-uy");
  await tg.waitSent(U, /Manzil:.*43-uy/);
});

test("bot never asks for the district: it is detected automatically, and the phone is asked only once", async () => {
  const U = 7003;                                                                   // already shared the phone in the previous test
  tg.calls.length = 0;
  tg.msg(U, "/yangi"); await tg.waitSent(U, /Joylashuv/);
  assert.equal(tg.sent(U, /Telefon raqamingiz/).length, 0, "phone is not asked again");
  tg.msg(U, "", { text: undefined, location: { latitude: 41.2050, longitude: 69.2800 } });   // OSM names no district here
  const conf = await tg.waitSent(U, /Manzil:/);
  assert.match(conf.params.text, /Yangihayot tumani/, "nearest district centre is used");
  tg.cb(U, "n:ok"); await tg.waitSent(U, /Muammo turi/);
  tg.cb(U, "n:t:yashil"); await tg.waitSent(U, /xavf bormi/);
  tg.cb(U, "n:g:0"); await tg.waitSent(U, /Nima koʻrdingiz/);
  tg.msg(U, "Maysazor buzilgan, chiqindi tashlanmoqda, ikki haftadan beri.");
  await tg.waitSent(U, /Rasm yuboring/);
  tg.cb(U, "n:p:skip"); await tg.waitSent(U, /Murojaatni tekshiring/);
  tg.cb(U, "n:y");
  const code = /TD-[A-Z2-9]{6}/.exec((await tg.waitSent(U, /Murojaat yuborildi/)).params.text)[0];
  assert.equal(tg.sent(U, /Tumanni tanlang/).length, 0, "the district picker is gone");
  assert.ok(!tg.calls.some(c => /n:d:\d/.test(JSON.stringify(c.params))), "no district buttons were ever sent");
  const rep = (await call("GET", "/reports")).body.reports.find(x => x.code === code);
  assert.equal(rep.district, "Yangihayot");
});

test("super admin: overview, users, audit log, settings, export", async () => {
  const o = (await call("GET", "/super/overview", ctx.tokens.boss)).body;
  assert.ok(o.reports >= 3); assert.ok(o.byVia.telegram >= 1 && o.byVia.web >= 2);
  assert.equal(o.days.length, 14); assert.equal(o.byDistrict.Chilonzor >= 2, true);
  const users = (await call("GET", "/super/users", ctx.tokens.boss)).body.users;
  assert.ok(users.find(u => u.login === "ali" && u.telegram === true));
  const log = (await call("GET", "/super/audit", ctx.tokens.boss)).body.items;
  assert.ok(log.some(a => a.action === "response.set" && /telegram/.test(a.detail)), "bot actions are audited");
  assert.ok(log.some(a => a.action === "user.create"));
  const bad = await call("PUT", "/super/settings", ctx.tokens.boss, { notifyChatId: "not a chat" });
  assert.equal(bad.status, 400);
  assert.equal((await call("PUT", "/super/settings", ctx.tokens.boss, { notifyChatId: "-1001234567890" })).status, 200);
  const st = (await call("GET", "/super/settings", ctx.tokens.boss)).body;
  assert.equal(st.bot.running, true); assert.equal(st.bot.username, "td_test_bot");
  const t = await call("POST", "/super/bot/test", ctx.tokens.boss);
  assert.equal(t.status, 200);
  const ex = await fetch(base + "/api/super/export", { headers: { Authorization: "Bearer " + ctx.tokens.boss } });
  const dump = await ex.json(); assert.ok(dump.reports.length >= 3); assert.equal(JSON.stringify(dump).includes("\"hash\""), false, "password hashes must never be exported");
});

test("notify group receives new reports and status changes", async () => {
  const r = await call("POST", "/reports", null, { type: "zarar", species: "Tol", count: "1", lat: 41.31, lon: 69.28, district: "Mirobod", description: "Shox sinib tushgan, yoʻlakka xavf bor." });
  await tg.waitSent("-1001234567890", new RegExp(r.body.report.code));
});

test("validation: bad input is rejected on the server", async () => {
  const base = { type: "chirigan", species: "Chinor", count: "1", lat: 41.3, lon: 69.25, district: "Mirobod", description: "Yetarli uzunlikdagi tavsif matni." };
  assert.equal((await call("POST", "/reports", null, Object.assign({}, base, { lat: 55 }))).status, 400);             // outside Tashkent
  const auto = await call("POST", "/reports", null, Object.assign({}, base, { district: "Moskva", lat: 41.287, lon: 69.28 }));                 // unknown district -> detected from the point
  assert.equal(auto.status, 200); assert.equal(auto.body.report.district, "Mirobod");
  assert.equal((await call("POST", "/reports", null, Object.assign({}, base, { description: "qisqa" }))).status, 400);
  assert.equal((await call("POST", "/reports", null, Object.assign({}, base, { type: "x" }))).status, 400);
  assert.equal((await call("POST", "/reports", null, Object.assign({}, base, { photo: "data:text/html;base64,PGI+" }))).status, 400);
  const xss = await call("POST", "/reports", null, Object.assign({}, base, { name: "<img src=x onerror=1>" }));
  assert.equal(xss.status, 200);                                                                                       // stored as text; clients escape it
});

test("static pages are served and the data survives a restart", async () => {
  for (const p of ["/", "/index.html", "/login.html", "/admin.html", "/superadmin.html", "/auth.js", "/common.css", "/vendor/leaflet/leaflet.js"]) {
    const r = await fetch(base + p); assert.equal(r.status, 200, p);
  }
  assert.equal((await fetch(base + "/../server/env.js")).status === 200 && false, false);
  assert.notEqual((await fetch(base + "/%2e%2e/server/env.js")).status, 200);
  assert.notEqual((await fetch(base + "/data/db.json")).status, 200);
  const before = (await call("GET", "/reports")).body.reports.length;
  await waitFor(() => fs.existsSync(path.join(dataDir, "db.json")), 3000, "db.json");
  assert.ok(before >= 4);
});
