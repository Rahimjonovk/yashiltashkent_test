"use strict";
/* Single source of truth for reference data (mirrors the front-end lists). */

const TYPES = {
  chirigan: { label: "Chirigan daraxt",       short: "Chirigan",     emoji: "🟤", tree: true },
  zarar:    { label: "Zarar yetgan daraxt",   short: "Zarar",        emoji: "🟠", tree: true },
  qurigan:  { label: "Qurigan daraxt",        short: "Qurigan",      emoji: "🟡", tree: true },
  kesish:   { label: "Noqonuniy kesish",      short: "Kesish",       emoji: "🔴", tree: true },
  yashil:   { label: "Yashil hudud muammosi", short: "Yashil hudud", emoji: "🔵", tree: false }
};
const TYPE_HINTS = {
  chirigan: "Tanasi yoki ildizi chirigan, kovak, zamburugʻ",
  zarar:    "Sinib tushgan shox, qiyshayish, mexanik shikast",
  qurigan:  "Bargsiz, shoxlari quruq, hayot belgisi yoʻq",
  kesish:   "Ruxsatsiz kesilgan yoki kesilayotgan daraxt",
  yashil:   "Maysazor yoki bogʻ buzilgan, chiqindi, toʻsib qoʻyilgan"
};
const STATUS = {
  yangi: { label: "Yangi",              emoji: "🔵" },
  korib: { label: "Koʻrib chiqilmoqda", emoji: "🟡" },
  hal:   { label: "Hal qilindi",        emoji: "✅" },
  rad:   { label: "Rad etildi",         emoji: "⛔" }
};
const SPECIES = ["Chinor","Tol","Terak","Qayragʻoch","Sofora","Tut","Akatsiya","Yongʻoq","Archa","Qaragʻay","Shumtol","Jiyda","Oʻrik","Olma","Kashtan","Magnoliya"];
const DISTRICTS = ["Bektemir","Chilonzor","Mirobod","Mirzo Ulugʻbek","Olmazor","Sergeli","Shayxontohur","Uchtepa","Yakkasaroy","Yangihayot","Yashnobod","Yunusobod"];
const COUNTS = { "1": "1 dona", "2-5": "2–5 dona", "6-20": "6–20 dona", "20+": "20 dan ortiq" };
const ROLES = ["user", "admin", "superadmin"];
const ROLE_LABEL = { user: "Foydalanuvchi", admin: "Moderator", superadmin: "Super admin" };

/* Same box the front-end uses to reject points outside Tashkent */
const PLACE = { s: 41.19, n: 41.44, w: 69.09, e: 69.42 };
const inPlace = (la, lo) => la >= PLACE.s && la <= PLACE.n && lo >= PLACE.w && lo <= PLACE.e;

/* Approximate district centres. Last-resort fallback: when OpenStreetMap does not name the district, the nearest centre wins,
   so a report always gets a district and nobody has to pick one by hand. */
const DISTRICT_CENTERS = {
  "Bektemir": [41.2303, 69.3367], "Chilonzor": [41.2750, 69.2000], "Mirobod": [41.2870, 69.2800], "Mirzo Ulugʻbek": [41.3380, 69.3300],
  "Olmazor": [41.3500, 69.2300], "Sergeli": [41.2150, 69.2250], "Shayxontohur": [41.3250, 69.2450], "Uchtepa": [41.3000, 69.1650],
  "Yakkasaroy": [41.2850, 69.2600], "Yangihayot": [41.2000, 69.2800], "Yashnobod": [41.3050, 69.3400], "Yunusobod": [41.3600, 69.2850]
};
function nearestDistrict(lat, lon) {
  lat = Number(lat); lon = Number(lon);
  if (!isFinite(lat) || !isFinite(lon)) return "";
  const k = Math.cos(41.3 * Math.PI / 180);   // longitude degrees are shorter than latitude degrees
  let best = "", bd = Infinity;
  for (const d of DISTRICTS) {
    const c = DISTRICT_CENTERS[d], dy = lat - c[0], dx = (lon - c[1]) * k, v = dy * dy + dx * dx;
    if (v < bd) { bd = v; best = d; }
  }
  return best;
}

module.exports = { TYPES, TYPE_HINTS, STATUS, SPECIES, DISTRICTS, COUNTS, ROLES, ROLE_LABEL, PLACE, inPlace, DISTRICT_CENTERS, nearestDistrict };
