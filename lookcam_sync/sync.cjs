// Boite aux lettres - download the recordings from the LookCam camera SD card over local P2P.
// Read-only on the camera: LoginDev, GetTfVideoList, DownloadFile. Never deletes anything.
//
// Protocol (reversed from LookCam 1.3.12):
//   commands on DRW channel 1, framed A0 AF AF AF|00|tz|u64 ts|8x00|u32 len|json|F4 F3 F2 F1
//   DownloadFile {patch,pos,state:1,userid} -> data on DRW channel 3 in chunks:
//     A0 AF AF AF|u32 userid|u32 seq|u32 0x7f|5 bytes|u32le len @21|data(len)|F4 F3 F2 F1
//   SD file names: CYC_DV_YYYYMMDD-HHMMSS@<duration ms>.mp4  (segment length set in the camera app)
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");

const CAM_IP = process.env.CAM_IP || "192.168.1.42";
const PWD = process.env.CAM_PASSWORD || "";
const OUT_DIR = process.env.OUT_DIR || path.join(process.env.USERPROFILE || ".", "Documents", "Boite_aux_lettres");
const MAX_FILES = Number(process.env.MAX_FILES || 1000);
// No data for this long = the transfer has dropped: close the session and resume at the same byte.
// The camera link drops a few times an hour; a fresh session usually restores full speed at once.
const STALL_MS = 15000;
// An attempt that moved the file forward before dropping is not counted as a failure, up to this many
// drops per file (then the usual 3 attempts apply).
const MAX_DROPS = 20;
const BUSY_WAIT_MS = 60000; // camera answered state=3 (still sending an earlier file): wait this long
const BUSY_MAX_MS = 10 * 60000; // give up the round after this much busy time
// Names already fetched. Lets the consumer (the PC) move clips away without them being downloaded again.
const STATE_FILE = process.env.STATE_FILE || "";
// Disk budget for OUT_DIR (bytes): the round stops once it is reached, the consumer empties the share.
const MAX_BYTES = Number(process.env.MAX_GB || 0) * 1e9;
// Names the consumer already has (one per line), e.g. written by the PC; never fetched again.
const SKIP_FILE = process.env.SKIP_FILE || path.join(OUT_DIR, "already_on_pc.txt");
const TZ = Math.round(-new Date().getTimezoneOffset() / 60);
// download order (add-on option download_order): oldest_first (default; the SD card overwrites its oldest
// files first) or newest_first (the latest recordings arrive first, the backlog after)
const NEWEST_FIRST = String(process.env.DOWNLOAD_ORDER || "").toLowerCase() === "newest_first";

// Log levels (add-on option log_level): debug > info > warning > error. info shows the progress of a round
// (SD listing every 10 pages, plan, each download with what is left); debug adds every page, every
// skipped file and the download progress every 15 s.
const LEVELS = { debug: 10, info: 20, warning: 30, error: 40 };
const LOG_LEVEL = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;
const emit = (lvl, tag) => (...a) => { if (LEVELS[lvl] >= LOG_LEVEL) console.log(new Date().toISOString(), tag, ...a); };
const log = { debug: emit("debug", "DEBUG"), info: emit("info", "INFO"), warn: emit("warning", "WARN"), error: emit("error", "ERROR") };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- pure helpers ----------
// "20261112052714" -> "12/11 05:27"
function fmtStamp(st) {
  return st && st.length >= 12 ? `${st.slice(6, 8)}/${st.slice(4, 6)} ${st.slice(8, 10)}:${st.slice(10, 12)}` : "?";
}
// 3725000 -> "1 h 02", 245000 -> "4 min", 35000 -> "35 s"
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}
const fmtGB = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
function clipInfo(item) {
  const m = /@(\d+)\.mp4$/.exec(item.patch || "");
  const durMs = m ? Number(m[1]) : null;
  const n = /(\d{8})-(\d{6})/.exec(item.name || item.patch || "");
  return {
    ...item,
    durMs,
    day: n ? `${n[1].slice(0, 4)}-${n[1].slice(4, 6)}-${n[1].slice(6, 8)}` : "unknown",
    stamp: n ? n[1] + n[2] : "", // YYYYMMDDHHMMSS from the file name, sorts chronologically
  };
}

// Parses the channel-3 download stream into file data chunks: onData(data, userid)
function makeChunkParser(onData) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 25) {
      if (buf.readUInt32LE(0) !== 0xafafafa0) {
        const i = buf.indexOf(Buffer.from([0xa0, 0xaf, 0xaf, 0xaf]), 1);
        buf = i < 0 ? Buffer.alloc(0) : buf.subarray(i);
        continue;
      }
      const len = buf.readUInt32LE(21);
      if (len > 1 << 20) { buf = buf.subarray(4); continue; }
      if (buf.length < 25 + len + 4) break;
      onData(buf.subarray(25, 25 + len), buf.readUInt32LE(4));
      buf = buf.subarray(25 + len + 4);
    }
  };
}

// ---------- PPPP session ----------
function pppp(type, p = Buffer.alloc(0)) {
  const h = Buffer.from([0xf1, type, 0, 0]);
  h.writeUInt16BE(p.length, 2);
  return Buffer.concat([h, p]);
}
function encodeJson(obj) {
  const j = Buffer.from(JSON.stringify(obj)), h = Buffer.alloc(26);
  h.writeUInt32LE(0xafafafa0, 0);
  h.writeInt8(TZ, 5);
  h.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000) + TZ * 3600), 6);
  h.writeUInt32LE(j.length, 22);
  return Buffer.concat([h, j, Buffer.from([0xf4, 0xf3, 0xf2, 0xf1])]);
}

function openSession() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    let cam = null, ready = false, outIdx = 0, ch1 = Buffer.alloc(0), lastRx = Date.now();
    const waiters = [];
    const order = {}; // per-channel in-order reassembly
    const sess = { onCh3: null, closed: false, lastRx: () => lastRx };
    const send = (b) => cam && !sess.closed && s.send(b, cam.port, cam.address);

    sess.cmd = (obj, timeoutMs = 10000) =>
      new Promise((res, rej) => {
        const h = Buffer.from([0xd1, 1, 0, 0]);
        h.writeUInt16BE(outIdx++ & 0xffff, 2);
        const w = { cmd: obj.cmd, res, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`timeout ${obj.cmd}`)); }, timeoutMs) };
        waiters.push(w);
        send(pppp(0xd0, Buffer.concat([h, encodeJson({ pwd: PWD, ...obj })])));
      });
    sess.close = () => {
      if (sess.closed) return;
      // tell the camera the session is over (MSG_CLOSE), otherwise it keeps the old session and its
      // download slot until its own timeout and answers DownloadFile with state=3 (busy) meanwhile
      try { if (cam) for (let i = 0; i < 3; i++) s.send(pppp(0xf0), cam.port, cam.address); } catch {}
      sess.closed = true; timers.forEach(clearInterval);
      setTimeout(() => { try { s.close(); } catch {} }, 200);
    };

    const deliver = (ch, idx, data, fn) => {
      const o = (order[ch] ||= { next: 0, pend: new Map() }); // camera numbers each channel from 0 per session
      if (((idx - o.next) & 0xffff) > 0x8000) return; // old duplicate
      o.pend.set(idx, data);
      while (o.pend.has(o.next)) { fn(o.pend.get(o.next)); o.pend.delete(o.next); o.next = (o.next + 1) & 0xffff; }
    };

    s.on("message", (m, r) => {
      if (m.length < 4 || m[0] !== 0xf1 || r.address !== CAM_IP) return;
      lastRx = Date.now();
      const t = m[1];
      if (t === 0x41 && !cam && m.length >= 24) {
        cam = r;
        send(pppp(0x41, m.subarray(4, 24)));
        send(pppp(0x42, m.subarray(4, 24)));
      } else if (t === 0x42 && cam && !ready) {
        ready = true;
        sess.cmd({ cmd: "LoginDev" }).then((rep) => (rep.result === 0 ? resolve(sess) : reject(new Error("login refused " + rep.result))), reject);
      } else if (t === 0xe0) send(pppp(0xe1));
      else if (t === 0xd0 && m.length >= 8) {
        const ch = m[5], idx = m.readUInt16BE(6);
        const a = Buffer.from([0xd1, ch, 0, 1, 0, 0]);
        a.writeUInt16BE(idx, 4);
        send(pppp(0xd1, a));
        if (ch === 1) deliver(1, idx, m.subarray(8), (d) => {
          ch1 = Buffer.concat([ch1, d]);
          while (ch1.length >= 26 && ch1.readUInt32LE(0) === 0xafafafa0) {
            const len = ch1.readUInt32LE(22);
            if (ch1.length < 30 + len) break;
            let rep = null;
            try { rep = JSON.parse(ch1.subarray(26, 26 + len).toString("utf8")); } catch {}
            ch1 = ch1.subarray(30 + len);
            const w = rep && waiters.find((x) => x.cmd === rep.cmd);
            if (w) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.res(rep); }
          }
        });
        else if (ch === 3) deliver(3, idx, m.subarray(8), (d) => sess.onCh3 && sess.onCh3(d));
      } else if (t === 0xf0) sess.close();
    });

    const search = Buffer.from([0xf1, 0x30, 0, 0]);
    const timers = [
      setInterval(() => { if (!cam) { s.send(search, 32108, CAM_IP); s.send(search, 32108, "255.255.255.255"); } }, 1500),
      setInterval(() => { if (ready) send(pppp(0xe0)); }, 1000),
    ];
    setTimeout(() => { if (!ready) { sess.close(); reject(new Error("camera not reachable")); } }, 20000);
    s.bind(() => { s.setBroadcast(true); s.send(search, 32108, CAM_IP); s.send(search, 32108, "255.255.255.255"); });
  });
}

// "20261112052714" -> epoch ms (camera local time read as UTC: only differences are used)
const stampMs = (st) => Date.UTC(+st.slice(0, 4), +st.slice(4, 6) - 1, +st.slice(6, 8), +st.slice(8, 10), +st.slice(10, 12), +st.slice(12, 14) || 0);

// Newest recording we already have (fetched index or the PC's list): an incremental round only needs the
// files recorded after it. Names look like 20261112-052714.mp4.
function newestKnown(...sets) {
  let best = "";
  for (const set of sets) for (const name of set) {
    const n = /(\d{8})-(\d{6})/.exec(name);
    if (n && n[1] + n[2] > best) best = n[1] + n[2];
  }
  return best;
}

async function listAll(ref, stopAt = "") {
  // The camera list is newest-first and shifts while it records, so one pass can skip files. A full
  // listing makes a second pass (union by path) only when the card changed during the first one (the file
  // count it reports moved) or a page went unanswered; otherwise one pass is complete.
  // Some pages never get an answer (seen on 2026-11-11, page 22) and leave the session stuck:
  // skip such a page on a fresh session instead of dropping the whole round.
  // stopAt (YYYYMMDDHHMMSS): incremental listing, stop one page after the first file at or before it,
  // instead of reading the whole card (up to 200 pages, 20-30 min). "" = full listing.
  // ref.sess is replaced when the session is reopened.
  const all = [];
  const t0 = Date.now();
  let total = 0, firstTotal = 0, skipped = 0, retries = 0, oldest = "", expected = 0, lastPage = 199;
  // incremental: one pass is enough, a file missed by a shift is caught by the daily full listing
  for (let pass = 0; pass < (stopAt ? 1 : 2); pass++) {
    if (pass) {
      if (total === firstTotal && !skipped) {
        log.info(`listing SD card: ${total} files before and after the pass, no second pass needed`);
        break;
      }
      log.info(`listing SD card: second pass over ${lastPage + 1} pages (` +
        (skipped ? `${skipped} page(s) unanswered` : `the card went from ${firstTotal} to ${total} files during the pass`) + ")");
    }
    let reached = false;
    for (let page = 0; page <= lastPage; page++) {
      let rep = null;
      for (let t = 1; t <= 2; t++) {
        try { rep = await ref.sess.cmd({ cmd: "GetTfVideoList", page, count: 10 }, 20000); break; }
        catch (e) {
          retries++;
          log.warn(`list page ${page}: ${e.message}${t < 2 ? ", retry on a new session" : ", skipped"}`);
          ref.sess.close();
          await sleep(3000);
          ref.sess = await openSession();
          log.debug("session reopened for the SD list");
        }
      }
      if (!rep) {
        skipped++;
        if (skipped > 5) { log.warn("too many unanswered list pages, using the partial list"); return finish(); }
        if (total && (page + 1) * 10 >= total + 10) break;
        continue;
      }
      total = rep.allCount || total;
      if (!firstTotal) firstTotal = total;
      const v = rep.value || [];
      all.push(...v);
      const st = v.map((x) => clipInfo(x).stamp).filter(Boolean).sort();
      if (st.length && (!oldest || st[0] < oldest)) oldest = st[0];
      if (pass === 0 && !expected && total) {
        // page estimate: whole card, or (incremental) from the time span of this first page
        expected = Math.min(Math.ceil(total / 10), Math.ceil((2 * MAX_FILES) / 10), 200);
        if (stopAt && st.length > 1) {
          const perPage = (stampMs(st[st.length - 1]) - stampMs(st[0])) * (10 / (st.length - 1));
          if (perPage > 0) expected = Math.min(expected, Math.ceil((stampMs(st[st.length - 1]) - stampMs(stopAt)) / perPage) + 2);
        }
        log.info(`listing SD card: the camera reports ${total} files; ` + (stopAt
          ? `new since ${fmtStamp(stopAt)}, about ${Math.max(expected, 1)} pages to read`
          : `full listing, about ${expected} pages to read`));
      }
      log.debug(`list page ${page}: ${v.length} files${st.length ? `, ${fmtStamp(st[0])} to ${fmtStamp(st[st.length - 1])}` : ""}`);
      if (pass === 0 && (page + 1) % 10 === 0)
        log.info(`listing SD card: page ${page + 1}/~${Math.max(expected, page + 1)}, ${all.length} files read, back to ${fmtStamp(oldest)}, ${fmtDur(Date.now() - t0)} so far`);
      if (!v.length || (page + 1) * 10 >= total + 10 || all.length >= 2 * MAX_FILES) { if (pass === 0) lastPage = page; break; }
      if (stopAt) {
        if (reached) { if (pass === 0) lastPage = page; break; } // one extra page of margin, then stop
        if (st.length && st[0] <= stopAt) reached = true;
      }
    }
  }
  return finish();
  function finish() {
    const list = [...new Map(all.map((v) => [v.patch, v])).values()].map(clipInfo);
    const st = list.map((c) => c.stamp).filter(Boolean).sort();
    log.info(`SD list read in ${fmtDur(Date.now() - t0)}: ${list.length} files` +
      (st.length ? `, from ${fmtStamp(st[0])} to ${fmtStamp(st[st.length - 1])}` : "") +
      `, ${retries} page retries, ${skipped} pages skipped`);
    return list;
  }
}

function download(sess, clip, dest) {
  const part = dest + ".part";
  const pos = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const fd = fs.openSync(part, "a");
  let got = pos, lastProgress = Date.now();
  const userid = 1 + Math.floor(Math.random() * 100);
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (err) => {
      if (finished) return;
      finished = true; clearInterval(tick); sess.onCh3 = null; fs.closeSync(fd);
      // on failure, pause this transfer on the camera (state 2 = PAUSE, PpcsDownloadControl in the app) to free its slot
      if (err && !sess.closed) sess.cmd({ cmd: "DownloadFile", patch: clip.patch, pos: got, state: 2, userid }, 3000).catch(() => {});
      err ? reject(err) : resolve();
    };
    sess.onCh3 = makeChunkParser((data, uid) => {
      if (uid !== userid) return;
      const take = Math.min(data.length, clip.size - got);
      if (take > 0) { fs.writeSync(fd, data, 0, take); got += take; lastProgress = Date.now(); }
      if (got >= clip.size) done();
    });
    let lastReport = Date.now(), reportedAt = got;
    const tick = setInterval(() => {
      if (sess.closed) return done(new Error("session closed"));
      // a mailbox motion is waiting (0.5.2): pause this transfer (state 2, resumed later from the .part)
      if (sess.preemptable && motionPending()) return done(Object.assign(new Error("motion pending"), { preempt: true }));
      if (Date.now() - lastProgress > STALL_MS) return done(Object.assign(new Error(`stalled at ${got}/${clip.size}`), { stalled: true, progressed: got > pos }));
      if (Date.now() - lastReport >= 15000) {
        const rate = (got - reportedAt) / ((Date.now() - lastReport) / 1000);
        log.debug(`  ${clip.name}: ${Math.floor((100 * got) / clip.size)} % (${(got / 1e6).toFixed(1)}/${(clip.size / 1e6).toFixed(1)} MB, ${(rate / 1e6).toFixed(2)} MB/s)`);
        lastReport = Date.now(); reportedAt = got;
      }
    }, 2000);
    if (pos) log.debug(`  ${clip.name}: resuming at ${(pos / 1e6).toFixed(1)} MB`);
    sess.cmd({ cmd: "DownloadFile", patch: clip.patch, pos, state: 1, userid }).then(
      (rep) => {
        log.debug(`  ${clip.name}: DownloadFile answered state=${rep.state}`);
        if (rep.state === 3) done(Object.assign(new Error("camera busy (state=3)"), { busy: true }));
        else if (rep.state !== 0) done(new Error("DownloadFile refused state=" + rep.state));
      },
      (e) => done(e),
    );
  }).then(() => { fs.renameSync(part, dest); });
}

function loadFetched() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch { return new Set(); }
}
function saveFetched(set) {
  if (!STATE_FILE) return;
  // bounded index (up to ~480 files/day with 3-min segments): keep the newest 20000 names. Not pruned
  // by the SD listing, which can skip files while the camera records.
  const keep = [...set].sort().slice(-20000);
  fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(keep));
  fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
}

// time of the last full SD listing, kept next to the fetched index
const FULL_LIST_FILE = STATE_FILE ? path.join(path.dirname(STATE_FILE), "last_full_list.txt") : "";
const FULL_LIST_EVERY_MS = 24 * 3600 * 1000;
function lastFullList() {
  try { return Date.parse(fs.readFileSync(FULL_LIST_FILE, "utf8").trim()) || 0; } catch { return 0; }
}
function markFullList() {
  if (FULL_LIST_FILE) try { fs.writeFileSync(FULL_LIST_FILE, new Date().toISOString()); } catch {}
}

// Watermark: every finished recording up to this stamp is fetched or on the PC. Regular rounds list the SD
// card down to it. Kept separately from the newest fetched file because with newest_first (or a round
// stopped by the storage budget) the newest file is fetched before older ones.
const WATERMARK_FILE = STATE_FILE ? path.join(path.dirname(STATE_FILE), "complete_until.txt") : "";
function loadWatermark() {
  try { const w = fs.readFileSync(WATERMARK_FILE, "utf8").trim(); return /^\d{14}$/.test(w) ? w : ""; } catch { return ""; }
}
function saveWatermark(w) {
  if (WATERMARK_FILE && w) try { fs.writeFileSync(WATERMARK_FILE, w); } catch {}
}
// "20261112052714" -> "20261112052713" (one second earlier)
function prevStamp(st) {
  const d = new Date(stampMs(st) - 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function loadSkip() {
  try { return new Set(fs.readFileSync(SKIP_FILE, "utf8").split(/\r?\n/).map((l) => l.trim().split(/[\\/]/).pop()).filter(Boolean)); }
  catch { return new Set(); }
}
function dirBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fetched = loadFetched();
  const round0 = Date.now();
  if (!PWD) log.warn("no camera password (CAM_PASSWORD)");
  log.info(`camera ${CAM_IP}, storage budget ${MAX_BYTES ? MAX_BYTES / 1e9 + " GB" : "none"}, ${fetched.size} names in the fetched index`);
  let sess = await openSession();
  log.info("session up");
  const ref = { sess };
  // Full listing at start-up (run.sh sets FULL_LIST=1 for the first round: every missing recording is
  // fetched, oldest first) and at least once a day to catch older gaps (a file that failed, a round cut
  // short). Other rounds are incremental: only what was recorded after the newest file we already have.
  const skip = loadSkip();
  const newest = loadWatermark() || newestKnown(fetched, skip);
  const fullDue = !newest || process.env.FULL_LIST === "1" || Date.now() - lastFullList() > FULL_LIST_EVERY_MS;
  log.info((fullDue ? "full round: whole SD card, every missing recording" : `regular round: recordings after ${fmtStamp(newest)}`) +
    `, ${NEWEST_FIRST ? "newest" : "oldest"} first`);
  const all = await listAll(ref, fullDue ? "" : newest);
  if (fullDue) markFullList();
  sess = ref.sess;
  const only = process.env.ONLY_DAY; // e.g. 2026-11-10 for tests
  // every finished recording, whatever its length (set in the camera app), oldest first:
  // the SD card loops and overwrites its oldest files first. No duration = still being recorded.
  const count = { recording: 0, onPc: 0, fetched: 0, onShare: 0, otherDay: 0 };
  const todo = [];
  for (const c of all) {
    const dir = path.join(OUT_DIR, c.day);
    const why = c.durMs === null ? "recording" : only && c.day !== only ? "otherDay" : skip.has(c.name) ? "onPc"
      : fetched.has(c.name) ? "fetched" : fs.existsSync(path.join(dir, c.name)) ? "onShare" : "";
    if (why) { count[why]++; log.debug(`skip ${c.name}: ${why}`); } else todo.push({ ...c, dir });
  }
  todo.sort((a, b) => (NEWEST_FIRST ? b.stamp.localeCompare(a.stamp) : a.stamp.localeCompare(b.stamp)));
  const todoBytes = todo.reduce((n, c) => n + (c.size || 0), 0);
  log.info(`${all.length} files listed, ${todo.length} to download (${fmtGB(todoBytes)}); ` +
    `${count.onPc} already on the PC, ${count.fetched} already fetched, ${count.onShare} already on the share, ${count.recording} being recorded` +
    (only ? `, ${count.otherDay} on other days` : ""));
  if (todo.length) log.info(`to download: ${fmtStamp(todo[0].stamp)} to ${fmtStamp(todo[todo.length - 1].stamp)}, ${NEWEST_FIRST ? "newest" : "oldest"} first`);
  let busySince = 0, nOk = 0, nFail = 0, bytesOk = 0, msOk = 0, stopped = "";
  const failed = new Set();
  outer: for (let i = 0; i < todo.length; i++) {
    const c = todo[i];
    if (MAX_BYTES) {
      const used = dirBytes(OUT_DIR);
      if (used + c.size > MAX_BYTES) {
        stopped = "storage budget";
        log.info(`storage budget reached (${fmtGB(used)} used of ${MAX_BYTES / 1e9} GB), the rest waits for the PC to empty the share`);
        break;
      }
    }
    fs.mkdirSync(c.dir, { recursive: true });
    const dest = path.join(c.dir, c.name);
    if (fs.existsSync(dest)) continue;
    // already fetched for a motion (kept apart): copy it locally instead of downloading it again
    const motionCopy = path.join(MOTION_DIR, c.day, c.name);
    if (fs.existsSync(motionCopy) && fs.statSync(motionCopy).size === c.size) {
      fs.copyFileSync(motionCopy, dest + ".part");
      fs.renameSync(dest + ".part", dest);
      fetched.add(c.name); saveFetched(fetched); nOk++;
      log.info(`ok [${i + 1}/${todo.length}] ${path.relative(OUT_DIR, dest)} copied from the motion folder`);
      continue;
    }
    if (motionPending()) { const r = { sess }; await serveMotions(r); sess = r.sess; }
    log.debug(`get [${i + 1}/${todo.length}] ${c.name} ${(c.size / 1e6).toFixed(1)} MB`);
    let drops = 0;
    const t0 = Date.now(); // whole time for this file, drops and reconnections included
    for (let attempt = 1; attempt <= 3; ) {
      try {
        if (sess.closed) { sess = await openSession(); log.info("session reopened"); }
        sess.preemptable = true;
        await download(sess, c, dest);
        busySince = 0;
        fetched.add(c.name);
        saveFetched(fetched);
        const ms = Date.now() - t0;
        nOk++; bytesOk += c.size; msOk += ms;
        const left = todo.slice(i + 1).reduce((n, x) => n + (x.size || 0), 0);
        const eta = bytesOk ? (left * msOk) / bytesOk : 0;
        log.info(`ok [${i + 1}/${todo.length}] ${path.relative(OUT_DIR, dest)} ${(c.size / 1e6).toFixed(1)} MB in ${Math.round(ms / 1000)} s` +
          (i + 1 < todo.length ? `, ${todo.length - i - 1} left (${fmtGB(left)}, about ${fmtDur(eta)})` : ""));
        break;
      } catch (e) {
        if (e.preempt) {
          // paused for a motion: serve it on the same session, then resume this file where it stopped
          log.info(`${c.name}: paused for a mailbox motion`);
          const r = { sess }; await serveMotions(r); sess = r.sess;
          continue;
        }
        if (e.busy) {
          // the camera still serves an earlier transfer: wait for it, do not count it as a failed attempt
          busySince ||= Date.now();
          if (Date.now() - busySince > BUSY_MAX_MS) { stopped = "camera busy"; log.warn(`camera still busy after ${BUSY_MAX_MS / 60000} min, next round`); break outer; }
          log.warn(`camera busy, waiting ${BUSY_WAIT_MS / 1000} s`);
          await sleep(BUSY_WAIT_MS); // keep the session open: closing and reopening does not free the slot sooner
          continue;
        }
        sess.close();
        if (e.stalled && e.progressed && drops < MAX_DROPS) {
          // dropped after making progress: reconnect at once and resume, not a failed attempt
          drops++;
          log.warn(`${c.name}: transfer dropped (${e.message}), reconnecting and resuming (drop ${drops})`);
          await sleep(1000);
          continue;
        }
        log.warn(`fail ${c.name} attempt ${attempt}/3: ${e.message}`);
        if (attempt === 3) { nFail++; failed.add(c.name); }
        attempt++;
        await sleep(attempt > 3 ? 3000 : e.stalled ? 1000 : 10000);
      }
    }
  }
  saveFetched(fetched);
  sess.close();
  // advance the watermark to just before the oldest recording still waiting (budget, busy camera), or to
  // the newest finished one listed when nothing waits. Files that failed 3 times do not hold it back:
  // the daily full listing tries them again.
  const waiting = todo.filter((c) => c.stamp && !fetched.has(c.name) && !failed.has(c.name)).map((c) => c.stamp).sort();
  const listed = all.filter((c) => c.stamp && c.durMs !== null).map((c) => c.stamp).sort();
  const mark = waiting.length ? prevStamp(waiting[0]) : listed[listed.length - 1] || "";
  if (mark && (!newest || mark > newest || fullDue)) { saveWatermark(mark); log.debug(`complete up to ${fmtStamp(mark)}`); }
  const left = todo.length - nOk - nFail;
  log.info(`round done in ${fmtDur(Date.now() - round0)}: ${nOk} downloaded (${fmtGB(bytesOk)}), ${nFail} failed` +
    (left > 0 ? `, ${left} left for the next round${stopped ? ` (${stopped})` : ""}` : ""));
}

// ---------- motion round (add-on 0.4.0) ----------
// Home Assistant sends the time of a motion (mailbox sensor) on the add-on stdin; run.sh calls this with
// MOTION_AT=YYYYMMDDHHMMSS (camera local time). We wait until the segment that covers that time is finished
// on the SD card, download it into MOTION_DIR/<day>/ (kept forever: outside the share the PC empties and
// outside the purge), then fire the Home Assistant event lookcam_sync_mouvement with its path.
const MOTION_DIR = process.env.MOTION_DIR || path.join(path.dirname(OUT_DIR), "boite_aux_lettres_mouvements");
const MOTION_WAIT_MS = Number(process.env.MOTION_WAIT_MS || 12 * 60000); // longest wait for the segment to end
const MOTION_POLL_MS = 60000;
const MOTION_MARGIN_S = 20; // motion this close to the end of a segment: take the next segment too

// Segments covering a motion time: the finished segment that contains it, plus the next one when the motion
// is within MOTION_MARGIN_S of its end. Returns { clips, pending } where pending = the covering segment (or
// the next one) is still being recorded.
function segmentsFor(list, at) {
  const t = stampMs(at);
  const done = list.filter((c) => c.stamp && c.durMs !== null).sort((a, b) => a.stamp.localeCompare(b.stamp));
  const recording = list.some((c) => c.durMs === null && c.stamp && stampMs(c.stamp) <= t);
  const i = done.findIndex((c) => stampMs(c.stamp) <= t && t < stampMs(c.stamp) + c.durMs);
  if (i < 0) return { clips: [], pending: recording || !done.some((c) => stampMs(c.stamp) > t) };
  const c = done[i];
  const clips = [c];
  let pending = false;
  if (stampMs(c.stamp) + c.durMs - t <= MOTION_MARGIN_S * 1000) {
    if (done[i + 1]) clips.push(done[i + 1]);
    else pending = true;
  }
  return { clips, pending };
}

async function fireEvent(type, data) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) { log.warn(`no SUPERVISOR_TOKEN, event ${type} not sent`); return; }
  try {
    const r = await fetch(`http://supervisor/core/api/events/${type}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) log.warn(`event ${type}: HTTP ${r.status}`);
    else log.info(`event ${type} sent`);
  } catch (e) { log.warn(`event ${type}: ${e.message}`); }
}

// Motion queue (0.5.2): run.sh reads the add-on stdin in the background and appends each motion time to
// this file, so a motion no longer waits for the end of a round (a start-up catch-up can last hours).
const MOTION_QUEUE = process.env.MOTION_QUEUE || (STATE_FILE ? path.join(path.dirname(STATE_FILE), "motion_queue") : "");
function motionPending() {
  try { return !!MOTION_QUEUE && fs.statSync(MOTION_QUEUE).size > 0; } catch { return false; }
}
// Takes the queued motion times (and empties the queue): oldest first, duplicates removed.
function takeMotions() {
  if (!MOTION_QUEUE) return [];
  const work = MOTION_QUEUE + ".work";
  try { fs.renameSync(MOTION_QUEUE, work); } catch { return []; }
  let lines = [];
  try { lines = fs.readFileSync(work, "utf8").split(/\r?\n/).map((l) => l.replace(/\D/g, "")).filter((l) => l.length === 14); } catch {}
  try { fs.unlinkSync(work); } catch {}
  return [...new Set(lines)].sort();
}
// Serves every queued motion on the session in ref (one camera session at a time), until the queue is empty.
async function serveMotions(ref) {
  for (let ats = takeMotions(); ats.length; ats = takeMotions()) {
    for (const at of ats) {
      try { await motionMain(at, ref); } catch (e) { log.warn(`motion ${at}: ${e.message}`); }
    }
  }
}

async function motionMain(at, shared = null) {
  if (!/^\d{14}$/.test(at)) throw new Error(`bad motion time ${at} (YYYYMMDDHHMMSS expected)`);
  const t0 = Date.now();
  log.info(`motion at ${fmtStamp(at)}:${at.slice(12, 14)}: waiting for the segment that covers it`);
  // list back to 10 min before the motion: a few pages at most
  const from = new Date(stampMs(at) - 10 * 60000).toISOString().replace(/\D/g, "").slice(0, 14);
  let sel = { clips: [], pending: true };
  const ref = shared || { sess: await openSession() };
  if (ref.sess.closed) ref.sess = await openSession();
  ref.sess.preemptable = false; // never pause a motion download for another motion
  try {
    while (true) {
      sel = segmentsFor(await listAll(ref, from), at);
      if (!sel.pending && sel.clips.length) break;
      if (Date.now() - t0 > MOTION_WAIT_MS) break;
      log.info(`segment still being recorded, next check in ${MOTION_POLL_MS / 1000} s`);
      ref.sess.close();
      await sleep(MOTION_POLL_MS);
      ref.sess = await openSession();
    }
    if (!sel.clips.length) {
      log.warn(`no finished segment covers ${fmtStamp(at)} after ${fmtDur(Date.now() - t0)}`);
      await fireEvent("lookcam_sync_mouvement", { heure: at, ok: false, erreur: "segment introuvable" });
      return;
    }
    const files = [];
    for (const c of sel.clips) {
      const dir = path.join(MOTION_DIR, c.day);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, c.name);
      if (!fs.existsSync(dest)) {
        for (let attempt = 1, drops = 0; ; attempt++) {
          try {
            if (ref.sess.closed) ref.sess = await openSession();
            ref.sess.preemptable = false;
            await download(ref.sess, c, dest);
            log.info(`ok motion segment ${c.day}/${c.name} ${(c.size / 1e6).toFixed(1)} MB`);
            break;
          } catch (e) {
            ref.sess.close();
            if (e.stalled && e.progressed && drops < MAX_DROPS) {
              drops++; attempt--; // dropped after progress: resume at once, not a failed attempt
              log.warn(`motion segment ${c.name}: transfer dropped, reconnecting and resuming (drop ${drops})`);
              await sleep(1000);
              continue;
            }
            log.warn(`fail motion segment ${c.name} attempt ${attempt}/3: ${e.message}`);
            if (attempt >= 3) throw e;
            await sleep(e.busy ? BUSY_WAIT_MS : e.stalled ? 1000 : 10000);
          }
        }
      } else log.info(`motion segment ${c.day}/${c.name} already there`);
      files.push(`${path.basename(MOTION_DIR)}/${c.day}/${c.name}`);
    }
    await fireEvent("lookcam_sync_mouvement", {
      heure: at, ok: true, fichiers: files,
      jour: sel.clips[0].day,
      dossier: `${path.basename(MOTION_DIR)}/${sel.clips[0].day}`,
    });
  } catch (e) {
    await fireEvent("lookcam_sync_mouvement", { heure: at, ok: false, erreur: e.message });
    throw e;
  } finally {
    if (!shared) ref.sess.close();
  }
}

module.exports = { takeMotions, motionPending, segmentsFor, clipInfo, makeChunkParser, openSession, listAll, loadSkip, dirBytes, fmtStamp, fmtDur, fmtGB, newestKnown, prevStamp };
if (require.main === module) {
  (process.env.MOTION_AT ? motionMain(process.env.MOTION_AT)
    : process.env.MOTION_SERVE === "1" ? (async () => { const r = { sess: { closed: true, close() {} } }; try { await serveMotions(r); } finally { r.sess.close(); } })()
    : main()).then(() => process.exit(0), (e) => { log.error(e.message); process.exit(1); });
}
