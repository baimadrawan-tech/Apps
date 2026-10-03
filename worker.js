/**
 * Dua Hati — backend Cloudflare Worker + KV.
 * Butuh binding KV bernama COUPLE_KV (lihat wrangler.toml).
 * Semua endpoint ada di /api/*, file front-end disajikan dari ./public via binding ASSETS.
 *
 * Endpoint:
 *   POST /api/create  {name}               -> {code, memberId, token}
 *   POST /api/join    {code, name}         -> {code, memberId, token}
 *   GET  /api/state                         (header Authorization: Bearer <token>, X-Room: <code>)
 *   POST /api/update  {section, data}      (header sama)
 *   POST /api/leave                         (header sama) — keluar & hapus data diri dari ruang
 */

const MAX_BODY = 400_000;          // batas ukuran request (byte)
const MAX_PHOTO = 160_000;         // batas data URL foto kenangan (karakter)
const MAX_MEMORIES = 120;
const MAX_EVENTS = 50;
const ROOM_TTL = 60 * 60 * 24 * 400; // ruang kedaluwarsa 400 hari tanpa aktivitas
const MOODS = ["😍","😊","😌","😐","😴","😢","😡","🥺","🤒","🥳"]; // harus sama dengan daftar di index.html

const corsHeaders = env => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Room",
  "Access-Control-Max-Age": "86400",
});
const json = (env, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(env) } });
const fail = (env, msg, status = 400) => json(env, { error: msg }, status);

const rand = (n, alphabet) => { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map(x => alphabet[x % alphabet.length]).join(""); };
const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // tanpa 0/O/1/I/L agar tidak tertukar
const TOKEN_ABC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
async function sha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v, min, max) => (typeof v === "number" && isFinite(v) && v >= min && v <= max ? v : null);
const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const now = () => Date.now();

const key = code => `room:${code}`;
const loadRoom = async (env, code) => (code && /^[A-Z0-9]{6}$/.test(code) ? await env.COUPLE_KV.get(key(code), "json") : null);
const saveRoom = (env, room) => env.COUPLE_KV.put(key(room.code), JSON.stringify(room), { expirationTtl: ROOM_TTL });

function newMember(name, tokenHash) {
  return { name, tokenHash, joinedAt: now(), lastSeen: now(), mood: null, moodAt: 0, sharing: false, loc: null, battery: null };
}
function newPet() { return { name: "Mochi", hunger: 80, happy: 80, energy: 80, xp: 0, level: 1, sleeping: false, updatedAt: now(), log: [] }; }

// Status pet turun seiring waktu (dihitung saat dibaca/diubah).
function decayPet(p) {
  const hrs = (now() - p.updatedAt) / 3_600_000;
  if (hrs > 0) {
    p.hunger = Math.max(0, p.hunger - hrs * 6);
    p.happy = Math.max(0, p.happy - hrs * 4);
    p.energy = p.sleeping ? Math.min(100, p.energy + hrs * 20) : Math.max(0, p.energy - hrs * 3);
    if (p.sleeping && p.energy >= 100) p.sleeping = false;
    p.updatedAt = now();
  }
  return p;
}

function haversine(a, b) {
  const R = 6371000, t = x => (x * Math.PI) / 180;
  const dLat = t(b.lat - a.lat), dLng = t(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function updateTogether(room) {
  const ms = Object.values(room.members).filter(m => m.sharing && m.loc);
  if (ms.length === 2 && haversine(ms[0].loc, ms[1].loc) < 150) { if (!room.togetherSince) room.togetherSince = now(); }
  else room.togetherSince = null;
}

// Versi state yang dikirim ke klien (tanpa hash token).
function publicState(room, meId) {
  const members = {};
  for (const [id, m] of Object.entries(room.members)) {
    const { tokenHash, ...rest } = m;
    members[id] = { ...rest, loc: m.sharing ? m.loc : null };
  }
  return { code: room.code, me: meId, startDate: room.startDate, members, events: room.events, memories: room.memories,
    pet: decayPet(room.pet), missYou: room.missYou, togetherSince: room.togetherSince, serverTime: now() };
}

async function auth(env, request) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const code = (request.headers.get("X-Room") || "").toUpperCase();
  if (!token) return { err: "Token tidak ada", status: 401 };
  const room = await loadRoom(env, code);
  if (!room) return { err: "Ruang tidak ditemukan", status: 404 };
  const h = await sha(token);
  const meId = Object.keys(room.members).find(id => room.members[id].tokenHash === h);
  if (!meId) return { err: "Token tidak valid untuk ruang ini", status: 403 };
  return { room, meId };
}

async function readBody(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) throw new Error("Data terlalu besar");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("Data terlalu besar");
  try { return JSON.parse(text || "{}"); } catch { throw new Error("JSON tidak valid"); }
}

function applyUpdate(room, meId, section, d) {
  const me = room.members[meId];
  const nm = me.name;
  switch (section) {
    case "mood":
      if (!MOODS.includes(d?.mood)) throw new Error("Mood tidak valid");
      me.mood = d.mood; me.moodAt = now(); return;
    case "location": {
      if (d?.sharing === false) { me.sharing = false; me.loc = null; break; }
      const lat = num(d?.lat, -90, 90), lng = num(d?.lng, -180, 180);
      if (lat === null || lng === null) throw new Error("Koordinat tidak valid");
      me.sharing = true;
      me.loc = { lat, lng, acc: num(d.acc, 0, 1e6), speed: num(d.speed, 0, 400), at: now() };
      break;
    }
    case "battery":
      me.battery = d?.available === false ? { available: false, at: now() }
        : { available: true, level: num(d?.level, 0, 1) ?? 0, charging: !!d?.charging, at: now() };
      return;
    case "profile":
      if (str(d?.name, 24)) me.name = str(d.name, 24);
      if (d?.startDate !== undefined) { if (d.startDate && !isDate(d.startDate)) throw new Error("Tanggal tidak valid"); room.startDate = d.startDate || null; }
      return;
    case "missyou":
      room.missYou = [{ from: meId, at: now(), id: rand(8, TOKEN_ABC) }, ...(room.missYou || [])].slice(0, 20); return;
    case "event": {
      if (d?.action === "delete") { room.events = room.events.filter(e => e.id !== d.id); return; }
      const title = str(d?.title, 60); if (!title || !isDate(d?.date)) throw new Error("Judul dan tanggal wajib diisi");
      const item = { id: d.id || rand(10, TOKEN_ABC), title, date: d.date, emoji: str(d.emoji, 8) || "💗",
        repeat: ["yearly", "monthly", "none"].includes(d.repeat) ? d.repeat : "yearly", by: meId, at: now() };
      const i = room.events.findIndex(e => e.id === item.id);
      if (i >= 0) room.events[i] = item; else { if (room.events.length >= MAX_EVENTS) throw new Error("Hari spesial sudah maksimal"); room.events.push(item); }
      return;
    }
    case "memory": {
      if (d?.action === "delete") {
        const m = room.memories.find(x => x.id === d.id);
        if (m && m.by !== meId) throw new Error("Hanya pembuat kenangan yang bisa menghapusnya");
        room.memories = room.memories.filter(x => x.id !== d.id); return;
      }
      const text = str(d?.text, 500); if (!text) throw new Error("Tulis sesuatu dulu");
      let photo = null;
      if (d.photo) {
        if (typeof d.photo !== "string" || !/^data:image\/(jpeg|webp|png);base64,/.test(d.photo)) throw new Error("Format foto tidak valid");
        if (d.photo.length > MAX_PHOTO) throw new Error("Foto terlalu besar");
        photo = d.photo;
      }
      room.memories.unshift({ id: rand(10, TOKEN_ABC), text, emoji: str(d.emoji, 8) || "💗", date: isDate(d.date) ? d.date : new Date().toISOString().slice(0, 10), photo, by: meId, at: now() });
      room.memories = room.memories.slice(0, MAX_MEMORIES);
      return;
    }
    case "pet": {
      const p = decayPet(room.pet);
      const act = d?.action;
      if (act === "rename") { p.name = str(d.name, 16) || p.name; }
      else if (act === "feed") { if (p.sleeping) throw new Error(`${p.name} sedang tidur`); p.hunger = Math.min(100, p.hunger + 25); p.xp += 10; }
      else if (act === "play") { if (p.sleeping) throw new Error(`${p.name} sedang tidur`); if (p.energy < 10) throw new Error(`${p.name} terlalu lelah, ajak tidur dulu`); p.happy = Math.min(100, p.happy + 25); p.energy = Math.max(0, p.energy - 15); p.hunger = Math.max(0, p.hunger - 5); p.xp += 12; }
      else if (act === "sleep") { p.sleeping = !p.sleeping; p.xp += 4; }
      else throw new Error("Aksi tidak dikenal");
      // Level naik jika dirawat konsisten: xp hanya penuh bila status rata-rata baik.
      const care = (p.hunger + p.happy + p.energy) / 3;
      if (care < 30) p.xp = Math.max(0, p.xp - 5);
      while (p.xp >= p.level * 60) { p.xp -= p.level * 60; p.level++; }
      const label = { feed: "memberi makan", play: "mengajak main", sleep: p.sleeping ? "menidurkan" : "membangunkan", rename: "mengganti nama jadi " + p.name }[act];
      p.log = [{ who: nm, text: label, at: now() }, ...p.log].slice(0, 15);
      return;
    }
    default: throw new Error("Bagian tidak dikenal");
  }
  updateTogether(room);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (!env.COUPLE_KV) return fail(env, "KV COUPLE_KV belum dihubungkan (cek wrangler.toml)", 500);

    try {
      const path = url.pathname;
      if (path === "/api/create" && request.method === "POST") {
        const b = await readBody(request); const name = str(b.name, 24);
        if (!name) return fail(env, "Nama panggilan wajib diisi");
        let code; for (let i = 0; i < 6; i++) { code = rand(6, CODE_ABC); if (!(await env.COUPLE_KV.get(key(code)))) break; }
        const token = rand(40, TOKEN_ABC), memberId = rand(8, TOKEN_ABC);
        const room = { code, createdAt: now(), startDate: null, members: { [memberId]: newMember(name, await sha(token)) }, events: [], memories: [], pet: newPet(), missYou: [], togetherSince: null };
        await saveRoom(env, room);
        return json(env, { code, memberId, token });
      }
      if (path === "/api/join" && request.method === "POST") {
        const b = await readBody(request); const name = str(b.name, 24); const code = str(b.code, 6).toUpperCase();
        if (!name) return fail(env, "Nama panggilan wajib diisi");
        if (!/^[A-Z0-9]{6}$/.test(code)) return fail(env, "Kode harus 6 karakter huruf/angka");
        const room = await loadRoom(env, code);
        if (!room) return fail(env, "Kode tidak ditemukan. Cek lagi ke pasanganmu.", 404);
        if (Object.keys(room.members).length >= 2) return fail(env, "Ruang ini sudah penuh (maksimal 2 orang).", 409);
        const token = rand(40, TOKEN_ABC), memberId = rand(8, TOKEN_ABC);
        room.members[memberId] = newMember(name, await sha(token));
        await saveRoom(env, room);
        return json(env, { code, memberId, token });
      }
      const a = await auth(env, request);
      if (a.err) return fail(env, a.err, a.status);
      const { room, meId } = a;
      if (path === "/api/state" && request.method === "GET") {
        room.members[meId].lastSeen = now();
        // tulis lastSeen paling sering tiap 60 dtk untuk hemat kuota tulis KV
        if (!room._seenWrite || now() - room._seenWrite > 60000) { room._seenWrite = now(); await saveRoom(env, room); }
        return json(env, publicState(room, meId));
      }
      if (path === "/api/update" && request.method === "POST") {
        const b = await readBody(request);
        applyUpdate(room, meId, str(b.section, 20), b.data || {});
        room.members[meId].lastSeen = now();
        await saveRoom(env, room);
        return json(env, publicState(room, meId));
      }
      if (path === "/api/leave" && request.method === "POST") {
        delete room.members[meId];
        if (Object.keys(room.members).length === 0) await env.COUPLE_KV.delete(key(room.code));
        else { room.togetherSince = null; await saveRoom(env, room); }
        return json(env, { ok: true });
      }
      return fail(env, "Endpoint tidak ditemukan", 404);
    } catch (e) {
      return fail(env, e.message || "Terjadi kesalahan", 400);
    }
  },
};
