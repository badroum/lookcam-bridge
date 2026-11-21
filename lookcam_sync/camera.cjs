"use strict";
// Camera settings (0.5.7): read the LookCam settings at every round and, on an explicit request only, write
// some of them. Field names reversed from LookCam 1.3.12 (com.tkzn.look_cam.ppcs.protocol) and checked
// against the answers of this camera on 2026-11-11.
//
// What is read (never GetDevInfo: it answers with the Wi-Fi name and password in clear):
//   carte  GetDevTfParam   SD card: state (0 none, 1 ready, 2 error), openRes (recording on), alarmRes,
//                          loopRes, audio, videoRes, videoCycle (segment length, s), totalSpace/freeSpace (MB)
//   alarme GetAlarmInfo    motion alarm: sensitivity (0 off, 1 low, 2 medium, 3 high), time, audio, goptime,
//                          putalarm, osd, starttime/endtime, twotime/twoend ("HH:MM"), flag
//   image  GetDevVideoInfo brightness, saturation (contrast, hue when the camera has them), 0-63
//   ir     GetLedInfo      infrared LED: control, starttime/endtime, flag, twotime/twoend
//
// Where a write request comes from (each one validated against the list below, nothing else is ever sent):
//   - the add-on options camera_* (Configuration tab), sent once when their value changes;
//   - the add-on stdin: hassio.addon_stdin with input {"camera": {"carte": {"openRes": 1}}} ("read" to
//     read only), written by run.sh into REQUEST_FILE;
//   - the file server: POST /camera (token), for the PC.
// Never sent: reboot, reset, clock (AppointDev), SD format (FormatCard), file deletion (DeleteTfFile),
// password, Wi-Fi, exposure (ranges unknown).
const fs = require("fs");
const path = require("path");

const DIR = process.env.CAMERA_DIR || "/data/camera";
const CONFIG_FILE = path.join(DIR, "config.json"); // last read, sensitive fields removed
const REQUEST_FILE = path.join(DIR, "request.json"); // pending write request (stdin, PC)
const RESULT_FILE = path.join(DIR, "result.json"); // outcome of the last request
const APPLIED_FILE = path.join(DIR, "applied_options.json"); // option values already sent
const BACKUP_DIR = path.join(DIR, "backup"); // one copy per change of the settings, before every write
const MAX_BACKUPS = 60;

const SENSITIVE = /pwd|pass|ssid|wifi|uid|p2p|mac|token|imei|^id$|key/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const flag = { type: "int", min: 0, max: 1 };
const hhmm = { type: "hhmm" };

const SECTIONS = {
  carte: {
    get: "GetDevTfParam", set: "SetDevTfParam",
    keys: { openRes: flag, alarmRes: flag, loopRes: flag, audio: flag, videoCycle: { type: "int", min: 60, max: 3600, step: 60 } },
    send: ["openRes", "alarmRes", "loopRes", "audio", "videoRes", "videoCycle"],
  },
  alarme: {
    get: "GetAlarmInfo", set: "SetAlarmInfo", timeout: 8000,
    keys: { sensitivity: { type: "int", min: 0, max: 3 }, putalarm: flag, osd: flag, audio: flag, flag,
      goptime: { type: "int", min: 0, max: 600 }, starttime: hhmm, endtime: hhmm, twotime: hhmm, twoend: hhmm },
    send: ["sensitivity", "time", "audio", "putalarm", "osd", "goptime", "starttime", "endtime", "twotime", "twoend", "flag"],
  },
  image: {
    get: "GetDevVideoInfo", set: "SetDevVideoInfo",
    // the camera rounds some values down by one (22 -> 21 on 11/11): accepted as applied
    keys: { brightness: { type: "int", min: 0, max: 63, tol: 1 }, saturation: { type: "int", min: 0, max: 63, tol: 1 },
      contrast: { type: "int", min: 0, max: 63, tol: 1 }, hue: { type: "int", min: 0, max: 63, tol: 1 } },
    send: ["brightness", "contrast", "hue", "saturation"],
  },
  ir: {
    get: "GetLedInfo", set: "SetLedInfo",
    keys: { control: { type: "int", min: 0, max: 2 }, starttime: hhmm, endtime: hhmm, twotime: hhmm, twoend: hhmm, flag },
    send: ["control", "starttime", "endtime", "flag", "twotime", "twoend"],
  },
};

// Add-on options -> settings. Unset option = left as it is on the camera.
const OPTIONS = {
  camera_sd_recording: ["carte", "openRes", (v) => (v ? 1 : 0)],
  camera_alarm_recording: ["carte", "alarmRes", (v) => (v ? 1 : 0)],
  camera_loop_recording: ["carte", "loopRes", (v) => (v ? 1 : 0)],
  camera_sd_audio: ["carte", "audio", (v) => (v ? 1 : 0)],
  camera_segment_minutes: ["carte", "videoCycle", (v) => Number(v) * 60],
  camera_sensitivity: ["alarme", "sensitivity", Number],
  camera_alarm_start: ["alarme", "starttime", String],
  camera_alarm_end: ["alarme", "endtime", String],
  camera_brightness: ["image", "brightness", Number],
  camera_saturation: ["image", "saturation", Number],
  camera_contrast: ["image", "contrast", Number],
  camera_hue: ["image", "hue", Number],
  camera_ir_mode: ["ir", "control", Number],
};

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(obj, null, 1));
  fs.renameSync(f + ".tmp", f);
}
let seq = 0;
const stamp = () => new Date().toISOString().replace(/\D/g, "").slice(0, 17) + "-" + String(seq++ % 100).padStart(2, "0");

// Answer of a Get command without the protocol and sensitive fields.
function clean(rep) {
  const out = {};
  for (const [k, v] of Object.entries(rep || {})) {
    if (k === "cmd" || k === "result" || SENSITIVE.test(k)) continue;
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

// One value against its rule: returns [value, error]
function checkValue(rule, v) {
  if (rule.type === "hhmm") return typeof v === "string" && HHMM.test(v) ? [v, ""] : [null, `"HH:MM" expected, got ${JSON.stringify(v)}`];
  if (typeof v === "boolean" && rule.max === 1) v = v ? 1 : 0;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) v = Number(v.trim());
  if (!Number.isInteger(v)) return [null, `integer expected, got ${JSON.stringify(v)}`];
  if (v < rule.min || v > rule.max) return [null, `${v} is outside ${rule.min}-${rule.max}`];
  if (rule.step && v % rule.step) return [null, `${v} is not a multiple of ${rule.step}`];
  return [v, ""];
}

// A request as sent by stdin, the PC or the options: { carte: {openRes: 1}, image: {...} } (optionally wrapped
// in {camera: ...}), or "read". Returns { read, changes, errors }.
function validate(req) {
  if (req && typeof req === "object" && "camera" in req) req = req.camera;
  if (req === "read" || req === "lire" || (req && (req.read === true || req.lire === true) && Object.keys(req).length === 1)) return { read: true, changes: {}, errors: [] };
  const errors = [], changes = {};
  if (!req || typeof req !== "object" || Array.isArray(req)) return { read: false, changes, errors: ["object expected, e.g. {\"carte\": {\"openRes\": 1}}"] };
  for (const [sec, vals] of Object.entries(req)) {
    if (sec === "read" || sec === "lire" || sec === "source") continue;
    const s = SECTIONS[sec];
    if (!s) { errors.push(`unknown section ${sec} (allowed: ${Object.keys(SECTIONS).join(", ")})`); continue; }
    if (!vals || typeof vals !== "object" || Array.isArray(vals)) { errors.push(`${sec}: object expected`); continue; }
    for (const [k, v] of Object.entries(vals)) {
      const rule = s.keys[k];
      if (!rule) { errors.push(`${sec}.${k} cannot be written (allowed: ${Object.keys(s.keys).join(", ")})`); continue; }
      const [val, err] = checkValue(rule, v);
      if (err) errors.push(`${sec}.${k}: ${err}`);
      else (changes[sec] ||= {})[k] = val;
    }
  }
  if (!errors.length && !Object.keys(changes).length) errors.push("nothing to change");
  return { read: false, changes, errors };
}

// Options of the add-on (/data/options.json) that changed since they were last sent.
function optionChanges(options, applied) {
  const req = {}, keys = [];
  for (const [opt, [sec, key, conv]] of Object.entries(OPTIONS)) {
    if (options[opt] === undefined || options[opt] === null || options[opt] === "") continue;
    if (applied[opt] === options[opt]) continue;
    (req[sec] ||= {})[key] = conv(options[opt]);
    keys.push(opt);
  }
  return { req, keys };
}
// Forget the options removed since, so that setting one again sends it again.
function pruneApplied(options, applied) {
  let changed = false;
  for (const k of Object.keys(applied)) if (options[k] === undefined || options[k] === null || options[k] === "") { delete applied[k]; changed = true; }
  return changed;
}

function sameValue(rule, want, got) {
  if (rule && rule.tol && Number.isInteger(want) && Number.isInteger(got)) return Math.abs(want - got) <= rule.tol;
  return want === got;
}

// Message for a Set: the current values of the fields the app sends, then the changes. The camera keeps the
// fields it has; fields it did not report are not invented.
function buildSet(sec, current, change) {
  const s = SECTIONS[sec], msg = { cmd: s.set };
  for (const k of s.send) if (current[k] !== undefined) msg[k] = current[k];
  Object.assign(msg, change);
  return msg;
}

// Section values worth comparing for a backup (free space moves all the time).
const comparable = (cfg) => JSON.stringify(Object.fromEntries(Object.keys(SECTIONS).map((s) => {
  const v = { ...(cfg[s] || {}) }; delete v.freeSpace; delete v.totalSpace; delete v.state; return [s, v];
})));

function backup(cfg, why) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  writeJson(path.join(BACKUP_DIR, `${stamp()}-${why}.json`), cfg);
  const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json")).sort();
  for (const f of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
}

function makeCamera({ log, fireEvent, pushSensor }) {
  // Reads every section on the open session; a section that does not answer keeps its last known values.
  async function readAll(sess, sections = Object.keys(SECTIONS)) {
    const prev = readJson(CONFIG_FILE, {});
    const cfg = { ...prev };
    const missing = [];
    for (const sec of sections) {
      try {
        const rep = await sess.cmd({ cmd: SECTIONS[sec].get }, 6000);
        if (rep && rep.result !== undefined && rep.result !== 0) throw new Error(`result ${rep.result}`);
        cfg[sec] = clean(rep);
      } catch (e) { missing.push(`${sec} (${e.message})`); }
    }
    cfg.read_at = new Date().toISOString();
    if (missing.length) log.warn(`camera settings not read: ${missing.join(", ")}`);
    if (comparable(cfg) !== comparable(prev)) {
      if (prev.read_at) log.info("camera settings changed since the last read (copy kept in /data/camera/backup)");
      backup(cfg, "read");
    }
    writeJson(CONFIG_FILE, cfg);
    // sections read just now (a write never relies on older values)
    Object.defineProperty(cfg, "fresh", { value: new Set(sections.filter((s) => !missing.some((m) => m.startsWith(s + " ")))) });
    return cfg;
  }

  // Writes the validated changes section by section: fresh read, backup, Set, read back, compare.
  async function apply(sess, changes, source) {
    const before = await readAll(sess, Object.keys(changes));
    backup(before, "before-write");
    const result = { at: new Date().toISOString(), source, ok: true, requested: changes, applied: {}, refused: [], before: {}, after: {} };
    for (const [sec, change] of Object.entries(changes)) {
      const s = SECTIONS[sec];
      const cur = before.fresh.has(sec) ? before[sec] : null;
      if (!cur || !Object.keys(cur).length) { result.ok = false; result.refused.push(`${sec}: current values unknown, nothing sent`); continue; }
      const todo = Object.fromEntries(Object.entries(change).filter(([k, v]) => !sameValue(s.keys[k], v, cur[k])));
      result.before[sec] = Object.fromEntries(Object.keys(change).map((k) => [k, cur[k] ?? null]));
      if (!Object.keys(todo).length) { result.applied[sec] = change; result.after[sec] = result.before[sec]; log.info(`camera ${sec}: already set, nothing sent`); continue; }
      const msg = buildSet(sec, cur, todo);
      log.info(`camera ${sec}: sending ${Object.entries(todo).map(([k, v]) => `${k} ${cur[k] ?? "?"} -> ${v}`).join(", ")}`);
      try { await sess.cmd(msg, s.timeout || 6000); } catch (e) { log.debug(`camera ${s.set}: ${e.message} (checked by reading back)`); }
      let got = {};
      try { const rep = await sess.cmd({ cmd: s.get }, 6000); got = clean(rep); } catch (e) { result.ok = false; result.refused.push(`${sec}: not read back (${e.message})`); continue; }
      result.after[sec] = Object.fromEntries(Object.keys(change).map((k) => [k, got[k] ?? null]));
      for (const [k, v] of Object.entries(change)) {
        if (sameValue(s.keys[k], v, got[k])) (result.applied[sec] ||= {})[k] = got[k];
        else { result.ok = false; result.refused.push(`${sec}.${k}: asked ${v}, camera has ${got[k] ?? "?"}`); }
      }
    }
    await readAll(sess, Object.keys(changes));
    writeJson(RESULT_FILE, result);
    if (result.ok) log.info(`camera settings applied (${source})`);
    else log.warn(`camera settings (${source}): ${result.refused.join("; ")}`);
    await fireEvent("lookcam_sync_camera", { ok: result.ok, source, demande: changes, avant: result.before, apres: result.after, refus: result.refused });
    return result;
  }

  const requestPending = () => { try { return fs.statSync(REQUEST_FILE).size > 0; } catch { return false; } };

  // Pending request from stdin or the PC: taken (file removed) before it is sent, so it runs once.
  async function serveRequest(sess) {
    if (!requestPending()) return null;
    const work = REQUEST_FILE + ".work";
    try { fs.renameSync(REQUEST_FILE, work); } catch { return null; }
    const raw = fs.readFileSync(work, "utf8");
    try { fs.unlinkSync(work); } catch {}
    let req, source = "stdin", id = null;
    try { req = JSON.parse(raw); } catch { req = null; }
    if (req && typeof req === "object" && req.source) { source = String(req.source).slice(0, 20); id = req.id || null; req = req.changes ?? req.camera ?? req; }
    const v = validate(req);
    if (v.errors.length) {
      const result = { at: new Date().toISOString(), id, source, ok: false, refused: v.errors, requested: req };
      writeJson(RESULT_FILE, result);
      log.warn(`camera request refused (${source}): ${v.errors.join("; ")}`);
      await fireEvent("lookcam_sync_camera", { ok: false, source, refus: v.errors });
      return result;
    }
    if (v.read) {
      const cfg = await readAll(sess);
      const result = { at: new Date().toISOString(), id, source, ok: true, read: true };
      writeJson(RESULT_FILE, result);
      log.info(`camera settings read (${source})`);
      await fireEvent("lookcam_sync_camera", { ok: true, source, lecture: cfg });
      return result;
    }
    const result = await apply(sess, v.changes, source);
    result.id = id;
    writeJson(RESULT_FILE, result);
    return result;
  }

  // Options camera_* changed since last sent. Marked as sent once the camera was reached, even when it kept
  // another value (said in the log): an option is sent again only when it changes, never at every round.
  async function serveOptions(sess, optionsFile = "/data/options.json") {
    const options = readJson(optionsFile, null);
    if (!options) return null;
    const applied = readJson(APPLIED_FILE, {});
    if (pruneApplied(options, applied)) writeJson(APPLIED_FILE, applied);
    const { req, keys } = optionChanges(options, applied);
    if (!keys.length) return null;
    const v = validate(req);
    if (v.errors.length) {
      log.warn(`camera options not sent: ${v.errors.join("; ")}`);
      for (const k of keys) applied[k] = options[k];
      writeJson(APPLIED_FILE, applied);
      return null;
    }
    log.info(`camera options changed: ${keys.join(", ")}`);
    const result = await apply(sess, v.changes, "options");
    const unread = result.refused.some((r) => /not read back|values unknown/.test(r));
    if (!unread) { for (const k of keys) applied[k] = options[k]; writeJson(APPLIED_FILE, applied); }
    return result;
  }

  // Home Assistant sensor sensor.lookcam_sync_camera: is the camera recording to its SD card?
  async function publish(cfg, newestOnCard, nowLocalMs, stampMs, fmtStamp) {
    const c = cfg.carte || {}, a = cfg.alarme || {}, im = cfg.image || {}, ir = cfg.ir || {};
    const cycleMs = (c.videoCycle || 1800) * 1000;
    const ageMs = newestOnCard ? nowLocalMs - stampMs(newestOnCard) : null;
    let state = "enregistre", warn = "";
    if (c.state === 0) { state = "carte absente"; warn = "no SD card in the camera"; }
    else if (c.state === 2) { state = "carte en erreur"; warn = "the camera reports an SD card error"; }
    else if (c.openRes === 0) { state = "enregistrement coupé"; warn = "SD recording is off in the camera (option camera_sd_recording to switch it on)"; }
    // margin of 90 min on top of two segments: a time zone mismatch between the camera and the host
    // (1 h) must not raise a false alarm
    else if (ageMs !== null && ageMs > 2 * cycleMs + 90 * 60000) {
      state = "n'enregistre pas";
      warn = `the camera is not recording: newest file on the SD card ${fmtStamp(newestOnCard)}, ${Math.round(ageMs / 3600000)} h ago`;
    } else if (!Object.keys(c).length) state = "inconnu";
    if (warn) log.warn(warn);
    const last = readJson(RESULT_FILE, null);
    await pushSensor("sensor.lookcam_sync_camera", state, {
      friendly_name: "LookCam caméra", icon: "mdi:cctv",
      carte: { 0: "absente", 1: "prête", 2: "erreur" }[c.state] ?? null,
      enregistrement_sd: c.openRes === undefined ? null : !!c.openRes,
      enregistrement_alarme: c.alarmRes === undefined ? null : !!c.alarmRes,
      boucle: c.loopRes === undefined ? null : !!c.loopRes,
      son: c.audio === undefined ? null : !!c.audio,
      duree_segment_min: c.videoCycle ? Math.round(c.videoCycle / 60) : null,
      espace_libre_go: c.freeSpace !== undefined ? Math.round(c.freeSpace / 100) / 10 : null,
      espace_total_go: c.totalSpace !== undefined ? Math.round(c.totalSpace / 100) / 10 : null,
      derniere_video_camera: newestOnCard ? fmtStamp(newestOnCard) : null,
      sensibilite: a.sensitivity ?? null, alarme_debut: a.starttime ?? null, alarme_fin: a.endtime ?? null,
      luminosite: im.brightness ?? null, saturation: im.saturation ?? null, contraste: im.contrast ?? null, teinte: im.hue ?? null,
      infrarouge: ir.control ?? null,
      lu_le: cfg.read_at || null,
      dernier_envoi: last ? `${last.at} ${last.source} ${last.ok ? "ok" : "refusé : " + (last.refused || []).join("; ")}` : null,
    });
    return state;
  }

  return { readAll, apply, serveRequest, serveOptions, publish, requestPending };
}

const loadConfig = () => readJson(CONFIG_FILE, {});

module.exports = { loadConfig, SECTIONS, OPTIONS, validate, optionChanges, pruneApplied, buildSet, clean, checkValue, sameValue, makeCamera,
  CONFIG_FILE, REQUEST_FILE, RESULT_FILE, DIR };
