// LookCam (PPPP/CS2, JSON commands) -> raw H.264 -> ffmpeg -> RTSP (MediaMTX). Local only, no cloud.
// Protocol notes (reversed from LookCam 1.3.12, libLuPPCSParseTool.so encodeData()):
//   handshake: LanSearch(F1 30) -> PunchPkt(F1 41) from cam -> we send PunchPkt + P2pRdy -> cam answers P2pRdy (F1 42)
//   commands : DRW channel 1, payload = A0 AF AF AF|00|tz i8|u64le ts|8x00|u32le len|json|F4 F3 F2 F1
//   video    : DRW channel 0, frames = 49-byte header (01 AF AF AF ...), u32le @41 = len-49, H.264 Annex-B @83
//   DrwAck   : F1 D1 len | D1 ch u16be count u16be idx...   (this firmware uses D1, not D2)
const dgram = require("dgram");
const { spawn } = require("child_process");

const CAM_IP = process.env.CAM_IP || "192.168.1.42";
const PWD = process.env.CAM_PASSWORD || "";
const STATE = Number(process.env.STATE || 2); // 1 = HD (main), 2 = SD (sub)
const RTSP_URL = process.env.RTSP_URL || "rtsp://127.0.0.1:8554/v99";
const TZ = Math.round(-new Date().getTimezoneOffset() / 60);
const MARK = 0x01afafaf;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- video frame parser (pure, testable) ----
function makeFrameParser(onH264) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 49) {
        if (buf.readUInt32BE(0) !== MARK) {
          const i = buf.indexOf(Buffer.from([0x01, 0xaf, 0xaf, 0xaf]), 1);
          buf = i < 0 ? Buffer.alloc(0) : buf.subarray(i);
          continue;
        }
        const len = 49 + buf.readUInt32LE(41);
        if (len > 4 * 1024 * 1024) { buf = buf.subarray(4); continue; } // garbage, resync
        if (buf.length < len) break;
        if (len > 83) onH264(buf.subarray(83, len));
        buf = buf.subarray(len);
      }
    },
    reset() { buf = Buffer.alloc(0); },
  };
}

// ---- PPPP helpers ----
const pppp = (type, payload = Buffer.alloc(0)) => {
  const h = Buffer.from([0xf1, type, 0, 0]);
  h.writeUInt16BE(payload.length, 2);
  return Buffer.concat([h, payload]);
};
const encodeJson = (obj) => {
  const json = Buffer.from(JSON.stringify(obj));
  const hdr = Buffer.alloc(26);
  hdr.writeUInt32LE(0xafafafa0, 0);
  hdr.writeInt8(TZ, 5);
  hdr.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000) + TZ * 3600), 6);
  hdr.writeUInt32LE(json.length, 22);
  return Buffer.concat([hdr, json, Buffer.from([0xf4, 0xf3, 0xf2, 0xf1])]);
};

// ---- ffmpeg (raw H.264 -> RTSP) ----
let ffmpeg = null;
function startFfmpeg() {
  stopFfmpeg();
  ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "+genpts", "-use_wallclock_as_timestamps", "1",
    "-f", "h264", "-i", "pipe:0",
    "-c", "copy", "-f", "rtsp", "-rtsp_transport", "tcp", RTSP_URL,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  ffmpeg.stdin.on("error", () => {});
  ffmpeg.on("exit", (c) => { log(`ffmpeg exited (${c})`); ffmpeg = null; });
}
function stopFfmpeg() { if (ffmpeg) { ffmpeg.kill("SIGKILL"); ffmpeg = null; } }

// ---- session ----
let backoff = 2000;
let current = null;

function connect() {
  const s = dgram.createSocket("udp4");
  let cam = null, ready = false, outIdx = 0, lastRx = Date.now(), gotVideo = false;
  let expected = null;
  const pending = new Map();
  const parser = makeFrameParser((h264) => {
    if (!gotVideo) { gotVideo = true; backoff = 2000; log("video flowing"); }
    if (!ffmpeg) startFfmpeg();
    ffmpeg.stdin.write(h264);
  });
  const send = (b) => cam && s.send(b, cam.port, cam.address);
  const sendCmd = (obj) => {
    const h = Buffer.from([0xd1, 1, 0, 0]);
    h.writeUInt16BE(outIdx++ & 0xffff, 2);
    send(pppp(0xd0, Buffer.concat([h, encodeJson(obj)])));
  };
  const openVideo = (state) => sendCmd({ cmd: "OpenVideo", pwd: PWD, state, stream: 0, userid: 1 + Math.floor(Math.random() * 100) });

  // in-order delivery of channel 0; skip a gap if too many packets pile up behind it
  const onVideoPkt = (idx, data) => {
    if (expected === null) expected = idx;
    if (((idx - expected) & 0xffff) > 0x8000) return; // old duplicate
    pending.set(idx, data);
    while (pending.has(expected)) { parser.push(pending.get(expected)); pending.delete(expected); expected = (expected + 1) & 0xffff; }
    if (pending.size > 64) { // lost packet -> drop to next available, parser resyncs on frame marker
      let next = expected, n = 0;
      while (!pending.has(next) && n++ < 0x8000) next = (next + 1) & 0xffff;
      expected = next;
      parser.reset();
      while (pending.has(expected)) { parser.push(pending.get(expected)); pending.delete(expected); expected = (expected + 1) & 0xffff; }
    }
  };

  s.on("message", (m, r) => {
    if (m.length < 4 || m[0] !== 0xf1) return;
    lastRx = Date.now();
    const type = m[1];
    if (type === 0x41 && !cam && r.address === CAM_IP && m.length >= 24) {
      cam = r;
      log(`camera found ${r.address}:${r.port}`);
      send(pppp(0x41, m.subarray(4, 24)));
      send(pppp(0x42, m.subarray(4, 24)));
    } else if (type === 0x42 && cam && !ready) {
      ready = true;
      log("session up, login + OpenVideo state=" + STATE);
      sendCmd({ cmd: "LoginDev", pwd: PWD });
      setTimeout(() => openVideo(STATE), 500);
    } else if (type === 0xe0) {
      send(pppp(0xe1));
    } else if (type === 0xd0 && m.length >= 8) {
      const ch = m[5], idx = m.readUInt16BE(6);
      const ack = Buffer.from([0xd1, ch, 0, 1, 0, 0]);
      ack.writeUInt16BE(idx, 4);
      send(pppp(0xd1, ack));
      if (ch === 0) onVideoPkt(idx, m.subarray(8));
      else if (ch === 1) {
        const body = m.subarray(8 + 26).toString("utf8").replace(/[^\x20-\x7e]/g, "");
        const cmd = (body.match(/"cmd"\s*:\s*"(\w+)"/) || [])[1];
        const res = (body.match(/"result"\s*:\s*(-?\d+)/) || [])[1];
        if (cmd) log(`cmd reply ${cmd} result=${res}`);
      }
    } else if (type === 0xf0) {
      log("camera closed session");
      teardown();
    }
  });

  const search = Buffer.from([0xf1, 0x30, 0, 0]);
  const timers = [
    setInterval(() => { if (!cam) { s.send(search, 32108, CAM_IP); s.send(search, 32108, "255.255.255.255"); } }, 2000),
    setInterval(() => { if (ready) send(pppp(0xe0)); }, 1000),
    setInterval(() => { if (Date.now() - lastRx > 10000) { log("no data for 10 s"); teardown(); } }, 2000),
  ];

  let closed = false;
  function teardown(final = false) {
    if (closed) return;
    closed = true;
    if (ready) openVideo(0);
    timers.forEach(clearInterval);
    setTimeout(() => s.close(), 200);
    stopFfmpeg();
    if (!final) {
      log(`reconnecting in ${backoff / 1000} s`);
      setTimeout(() => { current = connect(); }, backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }

  s.bind(() => { s.setBroadcast(true); s.send(search, 32108, CAM_IP); s.send(search, 32108, "255.255.255.255"); });
  return { teardown };
}

module.exports = { makeFrameParser };

if (require.main === module) {
  if (!PWD) log("warning: no password configured");
  current = connect();
  const stop = () => { log("stopping"); current && current.teardown(true); setTimeout(() => process.exit(0), 400); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
