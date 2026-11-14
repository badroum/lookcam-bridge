"use strict";
// Small read/delete file server for the PC, in place of the Samba add-on (lighter on a Raspberry Pi 3).
// LAN only, every request needs "Authorization: Bearer <http_token>". No dependency: Node's http module.
//   GET  /list                 -> {files:[{day, name, size, mtime}], parts:["day/name"]} finished recordings
//                                 oldest first, and the downloads in progress (.part)
//   GET  /file/<day>/<name>    -> the recording, with Range support (resume after a drop)
//   POST /done   {files:["day/name" | {day,name,size}]} -> deletes those the PC has copied (when a size is
//                                 given, only if it matches), then the day folder once empty
//   POST /have   {names:[...]}  (or PUT /have, text, one name per line) -> replaces already_on_pc.txt
//   GET  /status               -> sync status (round, phase, behind_files, behind_min, next_at...)
//   GET  /health               -> {ok:true} (no token needed)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.HTTP_PORT || 8099);
const TOKEN = process.env.HTTP_TOKEN || "";
const OUT_DIR = process.env.OUT_DIR || "/media/boite_aux_lettres";
const SKIP_FILE = process.env.SKIP_FILE || path.join(OUT_DIR, "already_on_pc.txt");
const STATUS_FILE = process.env.STATUS_FILE || "/data/status.json";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^\d{8}-\d{6}\.mp4$/;
const MAX_BODY = 4 * 1024 * 1024;
const LEVEL = { debug: 0, info: 1, warning: 2, error: 3 }[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 1;
const log = (lvl, msg) => { if (({ debug: 0, info: 1, warn: 2, error: 3 })[lvl] >= LEVEL) console.log(`${new Date().toISOString()} ${lvl.toUpperCase()} http: ${msg}`); };

function authorized(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(data), "Cache-Control": "no-store" });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error("body too large"), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}
function filePath(day, name) {
  if (!DAY_RE.test(day) || !NAME_RE.test(name)) return null;
  return path.join(OUT_DIR, day, name);
}
function listAll() {
  const files = [], parts = [];
  let days = [];
  try { days = fs.readdirSync(OUT_DIR).filter((d) => DAY_RE.test(d)).sort(); } catch { return { files, parts }; }
  for (const day of days) {
    let names = [];
    try { names = fs.readdirSync(path.join(OUT_DIR, day)).sort(); } catch { continue; }
    for (const name of names) {
      if (name.endsWith(".part") && NAME_RE.test(name.slice(0, -5))) { parts.push(`${day}/${name.slice(0, -5)}`); continue; }
      if (!NAME_RE.test(name)) continue;
      try { const st = fs.statSync(path.join(OUT_DIR, day, name)); files.push({ day, name, size: st.size, mtime: st.mtime.toISOString() }); } catch {}
    }
  }
  return { files, parts };
}

function serveFile(req, res, p) {
  let st;
  try { st = fs.statSync(p); } catch { return send(res, 404, { error: "not found" }); }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let start = 0, end = st.size - 1, code = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), st.size - 1); }
    else { start = Math.max(0, st.size - Number(range[2])); }
    if (start >= st.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      return res.end();
    }
    code = 206;
  }
  const headers = { "Content-Type": "video/mp4", "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (code === 206) headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(code, headers);
  if (req.method === "HEAD") return res.end();
  const s = fs.createReadStream(p, { start, end });
  s.on("error", () => res.destroy());
  s.pipe(res);
  log("debug", `${path.relative(OUT_DIR, p)} ${code} bytes ${start}-${end}`);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
  if (!authorized(req)) { log("warn", `refused ${req.method} ${url.pathname} from ${req.socket.remoteAddress}`); return send(res, 401, { error: "unauthorized" }); }
  if (req.method === "GET" && url.pathname === "/list") return send(res, 200, listAll());
  if (req.method === "GET" && url.pathname === "/status") {
    // written by sync.cjs (0.5.4): round, phase, recordings still to fetch, minutes behind the camera, next round
    try { return send(res, 200, JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"))); } catch { return send(res, 200, {}); }
  }
  if ((req.method === "GET" || req.method === "HEAD") && parts[0] === "file" && parts.length === 3) {
    const p = filePath(parts[1], parts[2]);
    return p ? serveFile(req, res, p) : send(res, 400, { error: "bad name" });
  }
  if (req.method === "POST" && url.pathname === "/done") {
    let files;
    try { files = JSON.parse(await readBody(req)).files; } catch (e) { return send(res, e.code || 400, { error: e.message }); }
    if (!Array.isArray(files)) return send(res, 400, { error: "files[] expected" });
    const deleted = [], kept = [];
    for (let f of files) {
      if (typeof f === "string") { const [day, name] = f.split("/"); f = { day, name }; }
      const p = f && filePath(String(f.day), String(f.name));
      let st = null;
      try { st = p && fs.statSync(p); } catch {}
      if (!st) { kept.push({ ...f, why: "not found" }); continue; }
      if (f.size !== undefined && st.size !== Number(f.size)) { kept.push({ ...f, why: `size ${st.size} on the Pi` }); continue; }
      try { fs.unlinkSync(p); deleted.push(`${f.day}/${f.name}`); } catch (e) { kept.push({ ...f, why: e.message }); }
    }
    for (const d of new Set(deleted.map((x) => x.split("/")[0]))) {
      try { if (!fs.readdirSync(path.join(OUT_DIR, d)).length) fs.rmdirSync(path.join(OUT_DIR, d)); } catch {}
    }
    if (deleted.length || kept.length) log("info", `PC has copied ${deleted.length} file(s), removed from the Pi${kept.length ? `; ${kept.length} kept` : ""}`);
    return send(res, 200, { deleted: deleted.length, files: deleted, kept });
  }
  if ((req.method === "PUT" || req.method === "POST") && url.pathname === "/have") {
    let lines;
    try {
      const text = await readBody(req);
      lines = req.method === "POST" ? JSON.parse(text).names : text.split(/\r?\n/);
      if (!Array.isArray(lines)) throw new Error("names[] expected");
    } catch (e) { return send(res, e.code || 400, { error: e.message }); }
    const names = [...new Set(lines.map((l) => String(l).trim().split(/[\\/]/).pop()).filter((n) => NAME_RE.test(n)))];
    fs.mkdirSync(path.dirname(SKIP_FILE), { recursive: true });
    fs.writeFileSync(SKIP_FILE + ".tmp", names.join("\n") + "\n");
    fs.renameSync(SKIP_FILE + ".tmp", SKIP_FILE);
    log("info", `list of files already on the PC updated: ${names.length} names`);
    return send(res, 200, { count: names.length });
  }
  send(res, 404, { error: "unknown route" });
}

if (require.main === module) {
  if (TOKEN.length < 16) { log("error", "http_token must be at least 16 characters: file server not started"); process.exit(0); }
  http.createServer((req, res) => handle(req, res).catch((e) => { log("error", e.message); if (!res.headersSent) send(res, 500, { error: "internal" }); else res.destroy(); }))
    .listen(PORT, () => log("info", `file server for the PC listening on port ${PORT} (${OUT_DIR})`));
}
module.exports = { handle, listAll };
