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
    sess.close = () => { if (sess.closed) return; sess.closed = true; timers.forEach(clearInterval); try { s.close(); } catch {} };

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

async function listAll(sess) {
  // The camera list is newest-first and shifts while it records, so one pass can skip files:
  // two full passes, union by path; enough at ~1 new file / 3 min.
  const all = [];
  for (let pass = 0; pass < 2; pass++) for (let page = 0; page < 200; page++) {
    let rep;
    for (let t = 1; ; t++) {
      try { rep = await sess.cmd({ cmd: "GetTfVideoList", page, count: 10 }, 20000); break; }
      catch (e) { if (t >= 3) throw e; log(`list page ${page} retry ${t}`); }
    }
    const v = rep.value || [];
    all.push(...v);
    if (!v.length || (page + 1) * 10 >= (rep.allCount || 0) + 10 || all.length >= 2 * MAX_FILES) break;
  }
  return [...new Map(all.map((v) => [v.patch, v])).values()].map(clipInfo);
}

function download(sess, clip, dest) {
  const part = dest + ".part";
  const pos = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const fd = fs.openSync(part, "a");
  let got = pos, lastProgress = Date.now();
  const userid = 1 + Math.floor(Math.random() * 100);
  return new Promise((resolve, reject) => {
    const done = (err) => { clearInterval(tick); sess.onCh3 = null; fs.closeSync(fd); err ? reject(err) : resolve(); };
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
      (rep) => { if (rep.state !== 0) done(new Error("DownloadFile refused state=" + rep.state)); },
      (e) => done(e),
    );
  }).then(() => { fs.renameSync(part, dest); });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!PWD) log("warning: no camera password (CAM_PASSWORD)");
  let sess = await openSession();
  log("session up");
  const clips = (await listAll(sess)).filter((c) => c.alarm).sort((a, b) => b.time - a.time);
  const only = process.env.ONLY_DAY; // e.g. 2026-11-10 for tests
  const todo = clips.filter((c) => (!only || c.day === only) && !fs.existsSync(path.join(OUT_DIR, c.day, c.name)));
  log(`${clips.length} alarm clips on SD, ${todo.length} to download`);
  for (const c of todo) {
    const dir = path.join(OUT_DIR, c.day);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, c.name);
    if (fs.existsSync(dest)) continue;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const t0 = Date.now();
      try {
        if (sess.closed) { sess = await openSession(); log("session reopened"); }
        await download(sess, c, dest);
        log(`ok ${c.day}/${c.name} ${(c.size / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - t0) / 1000)} s`);
        break;
      } catch (e) {
        log(`fail ${c.name} attempt ${attempt}: ${e.message}`);
        sess.close();
        await sleep(3000);
      }
    }
  }
  sess.close();
  log("done");
}

module.exports = { clipInfo, makeChunkParser, openSession, listAll };
if (require.main === module) {
  main().then(() => process.exit(0), (e) => { log("error: " + e.message); process.exit(1); });
}
