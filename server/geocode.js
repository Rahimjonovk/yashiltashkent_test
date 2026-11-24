"use strict";
/* Reverse geocoding (point -> full address) and forward search, via OpenStreetMap Nominatim.
   - serial queue, >= 1.1 s between Nominatim calls (their usage policy: max 1 request/second)
   - in-memory cache (same point is never asked twice within 24 h)
   - if Nominatim returns a street but no house number, Overpass is asked for the nearest building with addr:housenumber */
const cfg = require("./env");
const { DISTRICTS, nearestDistrict } = require("./constants");
const { E } = require("./auth");

const UA = "YashilToshkent/1.0 (tree and green-space reports for Tashkent" + (cfg.GEO_CONTACT ? "; " + cfg.GEO_CONTACT : "") + ")";

/* ---- district matching: tolerant of Latin/Cyrillic and apostrophe variants ---- */
const norm = s => String(s || "").toLowerCase().replace(/[ʻʼ'’‘`´ʹ]/g, "").replace(/\s+/g, " ").trim();
const ALIASES = {
  "Bektemir": ["bektemir", "бектемир"],
  "Chilonzor": ["chilonzor", "chilanzar", "chilonzar", "чиланзар", "чилонзор", "чилонзар"],
  "Mirobod": ["mirobod", "mirabad", "мирабад", "миробод"],
  "Mirzo Ulugʻbek": ["ulugbek", "улугбек", "улуғбек", "ulughbek"],
  "Olmazor": ["olmazor", "almazar", "алмазар", "олмазор"],
  "Sergeli": ["sergeli", "сергели"],
  "Shayxontohur": ["shayxontohur", "shayhantahur", "shaykhantakhur", "shayxontoxur", "shaykhontokhur", "shayhontohur", "шайхантахур", "шайхонтоҳур", "шайхонтохур"],
  "Uchtepa": ["uchtepa", "учтепа"],
  "Yakkasaroy": ["yakkasaroy", "yakkasaray", "яккасарай", "яккасарой"],
  "Yangihayot": ["yangihayot", "yangihayat", "янгихаёт", "янгиҳаёт", "янгихает"],
  "Yashnobod": ["yashnobod", "yashnabad", "яшнабад", "яшнобод"],
  "Yunusobod": ["yunusobod", "yunusabad", "юнусабад", "юнусобод"]
};
const DISTRICT_KEYS = ["city_district", "suburb", "county", "state_district", "municipality", "quarter", "city_block"];
function matchDistrict(addr) {
  for (const k of DISTRICT_KEYS) {
    const v = norm(addr && addr[k]);
    if (!v) continue;
    for (const d of DISTRICTS) if (ALIASES[d].some(a => v.indexOf(a) !== -1)) return d;
  }
  return "";
}

function streetOf(a) { return a.road || a.pedestrian || a.footway || a.path || a.cycleway || ""; }

function format(o) {
  const parts = [];
  if (o.district) parts.push(o.district + " tumani");
  if (o.road) parts.push(o.road);
  if (o.house) parts.push(o.house + "-uy" + (o.approx ? " yaqinida" : ""));
  if (parts.length) return parts.join(", ");
  return String(o.display || "").split(",").slice(0, 3).map(s => s.trim()).filter(Boolean).join(", ");
}

/* ---- HTTP helpers ---- */
async function getJson(url, opt) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), (opt && opt.timeout) || 8000);
  try {
    const r = await fetch(url, Object.assign({ signal: ac.signal, headers: { "User-Agent": UA, "Accept-Language": "uz,ru;q=0.8,en;q=0.5", "Accept": "application/json" } }, opt && opt.init));
    if (!r.ok) throw E(502, "geocode", "Manzil xizmati javob bermadi (" + r.status + ").");
    return await r.json();
  } catch (e) {
    if (e && e.status) throw e;
    throw E(502, "geocode", "Manzil xizmatiga ulanib boʻlmadi.");
  } finally { clearTimeout(t); }
}

let chain = Promise.resolve(), lastNom = 0;
function nominatim(path) {
  const run = async () => {
    const wait = lastNom + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNom = Date.now();
    return getJson(cfg.NOMINATIM_URL + path);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

const R = Math.PI / 180;
function dist(a, b, c, d) {
  const x = Math.sin((c - a) * R / 2) ** 2 + Math.cos(a * R) * Math.cos(c * R) * Math.sin((d - b) * R / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}
async function nearestHouse(lat, lon, road) {
  const q = '[out:json][timeout:6];(nwr["addr:housenumber"](around:35,' + lat + "," + lon + "););out center tags 30;";
  const j = await getJson(cfg.OVERPASS_URL, { timeout: 7000, init: { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) } });
  const els = (j.elements || []).map(e => {
    const la = e.lat != null ? e.lat : e.center && e.center.lat, lo = e.lon != null ? e.lon : e.center && e.center.lon;
    return la == null ? null : { d: dist(lat, lon, la, lo), tags: e.tags || {} };
  }).filter(Boolean).sort((a, b) => a.d - b.d);
  if (!els.length) return null;
  const sameStreet = road ? els.find(x => norm(x.tags["addr:street"]) === norm(road)) : null;
  const pick = sameStreet || els[0];
  return { house: String(pick.tags["addr:housenumber"]), street: pick.tags["addr:street"] || "", d: Math.round(pick.d) };
}

/* ---- public API ---- */
const cache = new Map();
const TTL = 24 * 3600 * 1000;
function cached(key) { const c = cache.get(key); if (c && Date.now() - c.t < TTL) return c.v; cache.delete(key); return null; }
function remember(key, v) { cache.set(key, { t: Date.now(), v }); if (cache.size > 3000) cache.delete(cache.keys().next().value); }

function shape(j, lat, lon) {
  const a = j.address || {};
  const named = matchDistrict(a);
  /* district is always filled: named by OSM, else the nearest district centre */
  return { lat, lon, district: named || nearestDistrict(lat, lon), districtGuess: !named, road: streetOf(a), house: a.house_number || "", approx: false, display: j.display_name || "" };
}

async function reverse(lat, lon) {
  if (cfg.GEO_DISABLED) throw E(503, "geocode", "Manzilni aniqlash oʻchirilgan.");
  lat = Number(lat); lon = Number(lon);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw E(400, "coords", "Koordinatalar notoʻgʻri.");
  const key = lat.toFixed(5) + "," + lon.toFixed(5);
  const hit = cached(key);
  if (hit) return hit;
  const j = await nominatim("/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=uz,ru,en&lat=" + lat + "&lon=" + lon);
  if (j.error) throw E(404, "geocode", "Bu nuqta uchun manzil topilmadi.");
  const o = shape(j, lat, lon);
  if (!o.house) {
    try {
      const h = await nearestHouse(lat, lon, o.road);
      if (h) { o.house = h.house; o.approx = h.d > 8; if (!o.road && h.street) o.road = h.street; }
    } catch (e) { /* Overpass is a bonus; ignore its failures */ }
  }
  o.address = format(o);
  o.ok = true;
  remember(key, o);
  return o;
}

async function search(text, limit) {
  if (cfg.GEO_DISABLED) throw E(503, "geocode", "Manzilni aniqlash oʻchirilgan.");
  const q = String(text || "").trim().slice(0, 120);
  if (q.length < 3) throw E(400, "query", "Manzilni kamida 3 ta belgi bilan yozing.");
  const key = "q:" + norm(q);
  const hit = cached(key);
  if (hit) return hit;
  const list = await nominatim("/search?format=jsonv2&addressdetails=1&limit=" + (limit || 3) + "&accept-language=uz,ru,en&viewbox=69.09,41.44,69.42,41.19&bounded=1&q=" + encodeURIComponent(q.replace(/\btumani\b/gi, "") + ", Toshkent"));
  const out = (Array.isArray(list) ? list : []).map(j => {
    const o = shape(j, Number(j.lat), Number(j.lon));
    o.address = format(o); o.ok = true; return o;
  }).filter(o => isFinite(o.lat) && isFinite(o.lon));
  remember(key, out);
  return out;
}

module.exports = { reverse, search, format, matchDistrict, norm, nearestDistrict };
