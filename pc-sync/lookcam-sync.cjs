#!/usr/bin/env node
// LookCam sync & motion analysis (runs on a PC, not on the Home Assistant host).
//
// 1. Copies finished recording segments from the add-on share (e.g. \\192.168.1.35\share\lookcam\v99)
//    that were not fetched yet.
// 2. Detects motion only inside a region of interest (the mailbox) with ffmpeg's scene score.
// 3. Keeps a short clip + a thumbnail per event, then drops the raw copy.
//
// Usage:
//   node lookcam-sync.cjs                  -> sync + analyse (default config: ./config.json)
//   node lookcam-sync.cjs --config c.json
//   node lookcam-sync.cjs --preview        -> writes preview.jpg (latest frame with the ROI drawn) to tune the ROI
//   node lookcam-sync.cjs --analyse f.mp4  -> analyse a single local file (debug)
//
// Requires ffmpeg in PATH (or "ffmpeg" in config). No other dependency.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const cfgPath = path.resolve(argVal("--config") || path.join(__dirname, "config.json"));

const DEFAULTS = {
  source: "\\\\192.168.1.35\\share\\lookcam\\v99", // add-on recordings (Samba share)
  dest: "C:\\LookCam",                            // clips/, thumbs/, state.json, sync.log
  ffmpeg: "ffmpeg",
  roi: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },        // fractions of the frame: the mailbox zone
  threshold: 0.012,                               // scene score (0..1) inside the ROI; lower = more sensitive
  analysis_fps: 4,
  pre_seconds: 5,
  post_seconds: 10,
  merge_gap_seconds: 8,                           // events closer than this become one clip
  min_age_seconds: 120,                           // never touch a segment still being written
  keep_days: 30,                                  // local clip retention (0 = keep forever)
};

const cfg = { ...DEFAULTS, ...(fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {}) };
cfg.roi = { ...DEFAULTS.roi, ...(cfg.roi || {}) };

const dirs = { clips: path.join(cfg.dest, "clips"), thumbs: path.join(cfg.dest, "thumbs"), tmp: path.join(cfg.dest, "tmp") };
Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
const statePath = path.join(cfg.dest, "state.json");
const logPath = path.join(cfg.dest, "sync.log");

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  fs.appendFileSync(logPath, line + "\n");
}

function ff(argv, opts = {}) {
  const r = spawnSync(cfg.ffmpeg, ["-hide_banner", "-nostdin", ...argv], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`ffmpeg not runnable (${r.error.code}). Install ffmpeg or set "ffmpeg" in config.json`);
  return r;
}

const roiCrop = () => {
  const { x, y, w, h } = cfg.roi;
  return `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y}`;
};

// Segment names written by MediaMTX: 2026-11-10_20-45-03-123456.mp4 -> Date (local time)
function segmentStart(file) {
  const m = path.basename(file).match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// Returns motion timestamps (seconds from file start) inside the ROI.
function detectMotion(file) {
  const vf = `${roiCrop()},scale=160:-2,fps=${cfg.analysis_fps},select='gt(scene\\,${cfg.threshold})',metadata=print:file=-`;
  const r = ff(["-loglevel", "error", "-i", file, "-an", "-vf", vf, "-f", "null", "-"]);
  if (r.status !== 0) throw new Error(`analysis failed: ${(r.stderr || "").trim().split("\n").pop()}`);
  const times = [];
  for (const m of (r.stdout || "").matchAll(/pts_time:([\d.]+)/g)) times.push(parseFloat(m[1]));
  return times;
}

function groupEvents(times) {
  const ev = [];
  for (const t of times) {
    const last = ev[ev.length - 1];
    if (last && t - last.end <= cfg.merge_gap_seconds) last.end = t;
    else ev.push({ start: t, end: t });
  }
  return ev;
}

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

function extract(file, events, base) {
  const out = [];
  for (const e of events) {
    const from = Math.max(0, e.start - cfg.pre_seconds);
    const to = e.end + cfg.post_seconds;
    const when = new Date(base.getTime() + e.start * 1000);
    const day = stamp(when).slice(0, 10);
    fs.mkdirSync(path.join(dirs.clips, day), { recursive: true });
    fs.mkdirSync(path.join(dirs.thumbs, day), { recursive: true });
    const name = stamp(when);
    const clip = path.join(dirs.clips, day, `${name}.mp4`);
    const thumb = path.join(dirs.thumbs, day, `${name}.jpg`);
    // Re-encode the short clip so it starts exactly at "from" (copy would snap to keyframes) — clips are small.
    ff(["-loglevel", "error", "-y", "-ss", String(from), "-to", String(to), "-i", file,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an", "-movflags", "+faststart", clip]);
    ff(["-loglevel", "error", "-y", "-ss", String(e.start), "-i", file, "-frames:v", "1", "-q:v", "3", thumb]);
    out.push(clip);
  }
  return out;
}

function analyseFile(file, base) {
  const times = detectMotion(file);
  const events = groupEvents(times);
  const clips = events.length ? extract(file, events, base || segmentStart(file) || new Date()) : [];
  return { motionFrames: times.length, events: events.length, clips };
}

function purgeOld() {
  if (!cfg.keep_days) return;
  const limit = Date.now() - cfg.keep_days * 86400e3;
  for (const root of [dirs.clips, dirs.thumbs]) {
    for (const day of fs.readdirSync(root)) {
      const d = new Date(day.slice(0, 10) + "T00:00:00");
      if (!isNaN(d) && d.getTime() < limit) fs.rmSync(path.join(root, day), { recursive: true, force: true });
    }
  }
}

function listSegments() {
  if (!fs.existsSync(cfg.source)) return null;
  return fs.readdirSync(cfg.source)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => ({ f, full: path.join(cfg.source, f), st: fs.statSync(path.join(cfg.source, f)) }))
    .sort((a, b) => a.f.localeCompare(b.f));
}

function preview() {
  const segs = listSegments();
  if (!segs || !segs.length) { log(`preview: no segment in ${cfg.source}`); process.exit(1); }
  const last = segs[segs.length - 1].full;
  const { x, y, w, h } = cfg.roi;
  const out = path.join(cfg.dest, "preview.jpg");
  ff(["-loglevel", "error", "-y", "-i", last, "-frames:v", "1",
    "-vf", `drawbox=x=iw*${x}:y=ih*${y}:w=iw*${w}:h=ih*${h}:color=red@0.9:t=3`, out]);
  log(`preview written: ${out} (red box = ROI, edit "roi" in config.json)`);
}

function sync() {
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { done: {} };
  const segs = listSegments();
  if (!segs) { log(`source not reachable (${cfg.source}) — not on Cindy's network / VPN down, will retry next run`); return; }
  const now = Date.now();
  const todo = segs.filter((s) => !state.done[s.f] && now - s.st.mtimeMs > cfg.min_age_seconds * 1000);
  log(`${segs.length} segment(s) on source, ${todo.length} to process`);
  let events = 0;
  for (const s of todo) {
    const local = path.join(dirs.tmp, s.f);
    try {
      fs.copyFileSync(s.full, local);
      const r = analyseFile(local, segmentStart(s.f));
      events += r.events;
      state.done[s.f] = { at: new Date().toISOString(), events: r.events };
      if (r.events) log(`${s.f}: ${r.events} event(s) -> ${r.clips.map((c) => path.basename(c)).join(", ")}`);
    } catch (e) {
      log(`${s.f}: ERROR ${e.message}`);
    } finally {
      fs.rmSync(local, { force: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
    }
  }
  // forget state entries for segments purged on the source
  const present = new Set(segs.map((s) => s.f));
  for (const k of Object.keys(state.done)) if (!present.has(k)) delete state.done[k];
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  purgeOld();
  log(`done: ${events} event(s)`);
}

module.exports = { groupEvents, segmentStart, analyseFile, cfg };

if (require.main === module) {
  // single-instance lock (scheduled task may overlap a long first run)
  const lock = path.join(cfg.dest, "sync.lock");
  try {
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 3 * 3600e3) { console.log("already running"); process.exit(0); }
    fs.writeFileSync(lock, String(process.pid));
    if (args.includes("--preview")) preview();
    else if (argVal("--analyse")) console.log(JSON.stringify(analyseFile(path.resolve(argVal("--analyse"))), null, 1));
    else sync();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
