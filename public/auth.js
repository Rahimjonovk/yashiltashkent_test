/* Client for the Yashil Toshkent server: sessions, API calls, live updates.
   Accounts live on the server (passwords are hashed there); the browser only keeps a session token. */
(function (global) {
"use strict";

var K_TOKEN = "td:token";

/* ---------- storage ---------- */
function st(kind){ try { return kind === "session" ? global.sessionStorage : global.localStorage; } catch (e) { return null; } }
function sget(k, kind){ try { var s = st(kind); return s ? s.getItem(k) : null; } catch (e) { return null; } }
function sset(k, v, kind){ try { var s = st(kind); if (!s) return false; s.setItem(k, v); return true; } catch (e) { return false; } }
function sdel(k, kind){ try { var s = st(kind); if (s) s.removeItem(k); } catch (e) {} }
function fail(code, message, extra){
  var e = new Error(message); e.code = code;
  if (extra) for (var k in extra) e[k] = extra[k];
  return e;
}
function noop(){}

/* ---------- server address ----------
   Same origin when the pages are served by the Node server (npm start).
   If you open them with VS Code Live Server (ports 5500-5503) or from disk, the API is expected at http://localhost:3000.
   Override: <script>window.TD_API="https://example.uz"</script> before auth.js, or localStorage["td:api"]. */
function apiBase(){
  var o = global.TD_API;
  if (o != null && o !== "") return String(o).replace(/\/+$/, "");
  var saved = sget("td:api");
  if (saved) return String(saved).replace(/\/+$/, "");
  var l = global.location;
  if (l.protocol === "file:") return "http://localhost:3000";
  if (/^550[0-3]$/.test(l.port)) return "http://localhost:3000";
  return "";
}
var BASE = apiBase();

/* ---------- token ---------- */
function token(){ return sget(K_TOKEN, "local") || sget(K_TOKEN, "session"); }
function setToken(t, remember){
  sdel(K_TOKEN, "local"); sdel(K_TOKEN, "session");
  if (!t) return;
  if (!sset(K_TOKEN, t, remember ? "local" : "session")) sset(K_TOKEN, t, "local");
}

var me = null, initP = null;

/* ---------- http ---------- */
function headers(extra){
  var h = extra || {};
  var t = token(); if (t) h["Authorization"] = "Bearer " + t;
  return h;
}
function api(path, opt){
  opt = opt || {};
  var h = { "Accept": "application/json" };
  var hadToken = !!token();
  var init = { method: opt.method || "GET", headers: headers(h) };
  if (opt.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opt.body); }
  return fetch(BASE + "/api" + path, init).then(function (r) {
    return r.text().then(function (txt) {
      var j = null; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
      if (r.ok) return j || {};
      var err = (j && j.error) || {};
      if (r.status === 401 && hadToken && err.code === "auth") { setToken(null); me = null; }   // expired / revoked session
      throw fail(err.code || "http", err.message || ("Server xatosi (" + r.status + ")."), { status: r.status });
    });
  }, function () {
    throw fail("network", "Server bilan aloqa yoʻq. Server ishga tushganini va internetni tekshiring.");
  });
}
function blob(path){
  return fetch(BASE + "/api" + path, { headers: headers() }).then(function (r) {
    if (!r.ok) throw fail("http", "Yuklab boʻlmadi (" + r.status + ").", { status: r.status });
    var cd = r.headers.get("Content-Disposition") || "", m = /filename="?([^";]+)"?/.exec(cd);
    return r.blob().then(function (b) { return { blob: b, filename: m ? m[1] : "download" }; });
  }, function () { throw fail("network", "Server bilan aloqa yoʻq."); });
}
function url(path){ return BASE + "/api" + path; }

/* ---------- session ---------- */
function init(force){
  if (initP && !force) return initP;
  initP = (token()
    ? api("/auth/me").then(function (r) { me = r.user || null; if (!me) setToken(null); }, function () { me = null; })
    : Promise.resolve((me = null))
  ).then(function () { return me; });
  return initP;
}
function current(){ return me; }
function isStaff(){ return !!me && (me.role === "admin" || me.role === "superadmin"); }
function isSuper(){ return !!me && me.role === "superadmin"; }

function login(loginName, password, remember){
  return api("/auth/login", { method: "POST", body: { login: loginName, password: password } }).then(function (r) {
    setToken(r.token, !!remember); me = r.user; initP = Promise.resolve(me);
    return me;
  });
}
function register(o){
  return api("/auth/register", { method: "POST", body: { name: o.name, login: o.login, password: o.password } }).then(function (r) {
    setToken(r.token, o.remember !== false); me = r.user; initP = Promise.resolve(me);
    return me;
  });
}
function logout(){
  var p = token() ? api("/auth/logout", { method: "POST" }).catch(noop) : Promise.resolve();
  setToken(null); me = null; initP = Promise.resolve(null);
  return p;
}
function changePassword(oldPw, newPw){
  return api("/auth/password", { method: "POST", body: { oldPassword: oldPw, newPassword: newPw } }).then(function () { if (me) me.mustChange = false; });
}
function refresh(){ return init(true); }

/* ---------- navigation helpers ---------- */
function safeNext(n){
  n = String(n || "");
  return /^(index|admin|superadmin)\.html(#[\w.-]*)?$/.test(n) ? n : "";
}
function requireAdmin(){
  if (!me) { global.location.replace("login.html?next=admin.html"); return null; }
  if (!isStaff()) { global.location.replace("login.html?next=admin.html&denied=1"); return null; }
  return me;
}
function requireSuper(){
  if (!me) { global.location.replace("login.html?next=superadmin.html"); return null; }
  if (!isSuper()) { global.location.replace("login.html?next=superadmin.html&denied=1"); return null; }
  return me;
}

/* ---------- live updates (Server-Sent Events, with polling as a fallback) ----------
   cb({v, kind}) is called (debounced) on every change and once on connect;
   onState(true|false) reports whether the live connection is up. */
function subscribe(cb, onState){
  var closed = false, es = null, poll = null, lastV = null, timer = 0;
  function fire(ev){ clearTimeout(timer); timer = setTimeout(function () { if (!closed) cb(ev); }, 150); }
  function startPoll(){
    if (poll) return;
    poll = setInterval(function () {
      api("/health").then(function (r) {
        if (onState) onState(true);
        if (lastV !== null && r.version !== lastV) fire({ v: r.version, kind: "poll" });
        lastV = r.version;
      }).catch(function () { if (onState) onState(false); });
    }, 12000);
  }
  try {
    es = new EventSource(BASE + "/api/stream");
    es.onopen = function () { if (poll) { clearInterval(poll); poll = null; } if (onState) onState(true); };
    es.onmessage = function (m) { try { var ev = JSON.parse(m.data); lastV = ev.v; fire(ev); } catch (e) {} };
    es.onerror = function () { if (onState) onState(false); startPoll(); };
  } catch (e) { startPoll(); }
  return function () { closed = true; if (es) es.close(); if (poll) clearInterval(poll); };
}

global.Auth = {
  init: init, refresh: refresh, current: current, login: login, register: register, logout: logout, changePassword: changePassword,
  isAdmin: isStaff, isStaff: isStaff, isSuper: isSuper, requireAdmin: requireAdmin, requireSuper: requireSuper, safeNext: safeNext,
  api: api, blob: blob, url: url, subscribe: subscribe, base: BASE,
  KEYS: { token: K_TOKEN }
};
})(window);
