// Parser self-check.
// - Always: synthetic frames (no camera capture needed, runs in CI).
// - Optional: a real capture (ch0 payloads in order): node test_parser.cjs path/to/stream_ch0.bin
const assert = require("assert");
const fs = require("fs");
const { makeFrameParser } = require("./bridge.cjs");

function frame(h264) {
  const hdr = Buffer.alloc(83);
  hdr.writeUInt32BE(0x01afafaf, 0);
  hdr.writeUInt32LE(83 - 49 + h264.length, 41);
  return Buffer.concat([hdr, h264]);
}
const nal = (type, n) => Buffer.concat([Buffer.from([0, 0, 0, 1, type]), Buffer.alloc(n, 0x55)]);
const synth = Buffer.concat([frame(nal(0x67, 10)), frame(nal(0x68, 4)), frame(nal(0x65, 3000)), frame(nal(0x41, 800))]);

function feed(buf, prefix = Buffer.alloc(0)) {
  const out = [];
  const p = makeFrameParser((h) => out.push(Buffer.from(h)));
  const all = Buffer.concat([prefix, buf]);
  for (let i = 0; i < all.length; ) { const n = 1 + Math.floor(Math.random() * 1500); p.push(all.subarray(i, i + n)); i += n; }
  return out;
}

let frames = feed(synth);
assert.strictEqual(frames.length, 4, "4 synthetic frames");
assert.ok(frames.every((f) => f.readUInt32BE(0) === 1), "start codes");
assert.strictEqual(frames[0][4] & 0x1f, 7, "SPS first");
assert.strictEqual(feed(synth, Buffer.from("junkjunkjunk")).length, 4, "resync after garbage");

const capPath = process.argv[2];
if (capPath && fs.existsSync(capPath)) {
  const cap = fs.readFileSync(capPath);
  frames = feed(cap);
  assert.ok(frames.length > 0 && frames.every((f) => f.readUInt32BE(0) === 1), "real capture parses");
  assert.ok(frames.some((f) => (f[4] & 0x1f) === 7), "SPS present in capture");
  console.log(`real capture: ${frames.length} frames`);
}
console.log("parser OK");
