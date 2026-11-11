// Boite aux lettres - download motion (alarm) clips from the LookCam camera SD card over local P2P.
// Read-only on the camera: LoginDev, GetTfVideoList, DownloadFile. Never deletes anything.
//
// Protocol (reversed from LookCam 1.3.12):
//   commands on DRW channel 1, framed A0 AF AF AF|00|tz|u64 ts|8x00|u32 len|json|F4 F3 F2 F1
//   DownloadFile {patch,pos,state:1,userid} -> data on DRW channel 3 in chunks:
//     A0 AF AF AF|u32 userid|u32 seq|u32 0x7f|5 bytes|u32le len @21|data(len)|F4 F3 F2 F1
//   SD file names: CYC_DV_YYYYMMDD-HHMMSS@<duration ms>.mp4  (alarm clips ~180 s, continuous ~1800 s)
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");

const CAM_IP = process.env.CAM_IP || "192.168.1.42";
const PWD = process.env.CAM_PASSWORD || "";
const OUT_DIR = process.env.OUT_DIR || path.join(process.env.USERPROFILE || ".", "Documents", "Boite_aux_lettres");
const MAX_CLIP_MS = Number(process.env.MAX_CLIP_MS || 600000); // shorter than this = alarm clip
const MAX_FILES = Number(process.env.MAX_FILES || 1000);
const STALL_MS = 30000;
const BUSY_WAIT_MS = 60000; // camera answered state=3 (still sending an earlier file): wait this long
const BUSY_MAX_MS = 10 * 60000; // give up the round after this much busy time
// Names already fetched. Lets the consumer (the PC) move clips away without them being downloaded again.
const STATE_FILE = process.env.STATE_FILE || "";
// Optional: also fetch the continuous (~30 min) recordings, after the alarm clips, into OUT_DIR/continu/<day>/.
const CONTINUOUS = process.env.CONTINUOUS === "1";
// Disk budget for OUT_DIR (bytes). Continuous files are skipped once it is reached; alarm clips always go.
const MAX_BYTES = Number(process.env.MAX_GB || 0) * 1e9;
// Names the consumer already has (one per line), e.g. written by the PC; never fetched again.
const SKIP_FILE = process.env.SKIP_FILE || path.join(OUT_DIR, "already_on_pc.txt");
const TZ = Math.round(-new Date().getTimezoneOffset() / 60);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- pure helpers ----------
function clipInfo(item) {
  const m = /@(\d+)\.mp4$/.exec(item.patch || "");
  const durMs = m ? Number(m[1]) : null;
  const n = /(\d{8})-(\d{6})/.exec(item.name || item.patch || "");
  return {
    ...item,
    durMs,
    alarm: durMs !== null && durMs < MAX_CLIP_MS,
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

async function listAll(ref) {
  // The camera list is newest-first and shifts while it records, so one pass can skip files:
  // two full passes, union by path; enough at ~1 new file / 3 min.
  // Some pages never get an answer (seen on 2026-11-11, page 22) and leave the session stuck:
  // skip such a page on a fresh session instead of dropping the whole round.
  // ref.sess is replaced when the session is reopened.
  const all = [];
  let total = 0, skipped = 0;
  for (let pass = 0; pass < 2; pass++) for (let page = 0; page < 200; page++) {
    let rep = null;
    for (let t = 1; t <= 2; t++) {
      try { rep = await ref.sess.cmd({ cmd: "GetTfVideoList", page, count: 10 }, 20000); break; }
      catch (e) {
        log(`list page ${page}: ${e.message}${t < 2 ? ", retry on a new session" : ", skipped"}`);
        ref.sess.close();
        await sleep(3000);
        ref.sess = await openSession();
      }
    }
    if (!rep) {
      skipped++;
      if (skipped > 5) { log("too many unanswered list pages, using the partial list"); return finish(); }
      if (total && (page + 1) * 10 >= total + 10) break;
      continue;
    }
    total = rep.allCount || total;
    const v = rep.value || [];
    all.push(...v);
    if (!v.length || (page + 1) * 10 >= total + 10 || all.length >= 2 * MAX_FILES) break;
  }
  return finish();
  function finish() { return [...new Map(all.map((v) => [v.patch, v])).values()].map(clipInfo); }
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
    const tick = setInterval(() => {
      if (sess.closed) return done(new Error("session closed"));
      if (Date.now() - lastProgress > STALL_MS) return done(new Error(`stalled at ${got}/${clip.size}`));
    }, 2000);
    sess.cmd({ cmd: "DownloadFile", patch: clip.patch, pos, state: 1, userid }).then(
      (rep) => {
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
  // bounded index (~40 alarm clips/day): keep the newest 5000 names. Not pruned by the SD listing,
  // which can skip files while the camera records.
  const keep = [...set].sort().slice(-5000);
  fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(keep));
  fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
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
  if (!PWD) log("warning: no camera password (CAM_PASSWORD)");
  let sess = await openSession();
  log("session up");
  const ref = { sess };
  const all = await listAll(ref);
  sess = ref.sess;
  const skip = loadSkip();
  const only = process.env.ONLY_DAY; // e.g. 2026-11-10 for tests
  const wanted = (c) => (!only || c.day === only) && !fetched.has(c.name) && !skip.has(c.name);
  // oldest first, whatever the kind: the SD card loops and overwrites its oldest files first
  const alarms = all.filter((c) => c.alarm && wanted(c))
    .map((c) => ({ ...c, dir: path.join(OUT_DIR, c.day) }));
  const conts = !CONTINUOUS ? [] : all.filter((c) => !c.alarm && c.durMs !== null && wanted(c))
    .map((c) => ({ ...c, dir: path.join(OUT_DIR, "continu", c.day) }));
  const todo = [...alarms, ...conts].sort((a, b) => a.stamp.localeCompare(b.stamp))
    .filter((c) => !fs.existsSync(path.join(c.dir, c.name)));
  log(`${all.filter((c) => c.alarm).length} alarm clips on SD, ${alarms.length} alarm + ${conts.length} continuous to download`);
  let busySince = 0, budgetFull = false;
  outer: for (const c of todo) {
    if (!c.alarm && budgetFull) continue;
    if (!c.alarm && MAX_BYTES && dirBytes(OUT_DIR) + c.size > MAX_BYTES) {
      // keep fetching the alarm clips, only the continuous files wait for the next round
      log(`storage budget reached (${MAX_BYTES / 1e9} GB), continuous files left for next round`);
      budgetFull = true;
      continue;
    }
    fs.mkdirSync(c.dir, { recursive: true });
    const dest = path.join(c.dir, c.name);
    if (fs.existsSync(dest)) continue;
    for (let attempt = 1; attempt <= 3; ) {
      const t0 = Date.now();
      try {
        if (sess.closed) { sess = await openSession(); log("session reopened"); }
        await download(sess, c, dest);
        busySince = 0;
        fetched.add(c.name);
        saveFetched(fetched);
        log(`ok ${path.relative(OUT_DIR, dest)} ${(c.size / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - t0) / 1000)} s`);
        break;
      } catch (e) {
        if (e.busy) {
          // the camera still serves an earlier transfer: wait for it, do not count it as a failed attempt
          busySince ||= Date.now();
          if (Date.now() - busySince > BUSY_MAX_MS) { log(`camera still busy after ${BUSY_MAX_MS / 60000} min, next round`); break outer; }
          log(`camera busy, waiting ${BUSY_WAIT_MS / 1000} s`);
          await sleep(BUSY_WAIT_MS); // keep the session open: closing and reopening does not free the slot sooner
          continue;
        }
        log(`fail ${c.name} attempt ${attempt}: ${e.message}`);
        attempt++;
        sess.close();
        await sleep(attempt <= 3 ? 10000 : 3000);
      }
    }
  }
  saveFetched(fetched);
  sess.close();
  log("done");
}

module.exports = { clipInfo, makeChunkParser, openSession, listAll, loadSkip, dirBytes };
if (require.main === module) {
  main().then(() => process.exit(0), (e) => { log("error: " + e.message); process.exit(1); });
}
