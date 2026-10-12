/**
 * 生成 LaunchPad 品牌图标 icon.ico（渐变圆角方块 + 白色闪电，16/32/64 三档）
 * 纯 Node 实现：手绘像素 → PNG(RGBA) → 打包 ICO，无第三方依赖。
 * 用法：node tools/make-icon.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}
function pngEncode(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 绘制 ---------- */
const BOLT = [[36, 8], [17, 35], [29, 35], [25, 56], [47, 27], [34, 27]];
function inPoly(x, y) {
  let inside = false;
  for (let i = 0, j = BOLT.length - 1; i < BOLT.length; j = i++) {
    const [xi, yi] = BOLT[i], [xj, yj] = BOLT[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const lerp = (a, b, t) => a + (b - a) * t;
const C0 = [0x34, 0xe0, 0xe8], C1 = [0x6f, 0x8c, 0xff], C2 = [0xb0, 0x7a, 0xf7];
const grad = (t) => (t < 0.5 ? C0.map((v, i) => lerp(v, C1[i], t * 2)) : C1.map((v, i) => lerp(v, C2[i], (t - 0.5) * 2)));

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4; // 超采样倍数
  const r = (15 / 64) * size, half = size / 2, k = 64 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0, bolt = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S, fy = y + (sy + 0.5) / S;
          const qx = Math.abs(fx - half) - (half - r);
          const qy = Math.abs(fy - half) - (half - r);
          const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
          if (sd < 0) {
            cov++;
            if (inPoly(fx * k, fy * k)) bolt++;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (!cov) continue;
      const n = S * S;
      const g = grad((x + y) / (2 * size));
      const b = bolt / n;
      px[i] = Math.round(lerp(g[0], 255, b));
      px[i + 1] = Math.round(lerp(g[1], 255, b));
      px[i + 2] = Math.round(lerp(g[2], 255, b));
      px[i + 3] = Math.round((cov / n) * 255);
    }
  }
  return px;
}

/* ---------- ICO 打包（PNG-in-ICO） ---------- */
function buildIco(sizes) {
  const pngs = sizes.map((s) => ({ s, png: pngEncode(s, s, drawIcon(s)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + 16 * sizes.length;
  pngs.forEach((p, i) => {
    const e = dir.subarray(16 * i, 16 * i + 16);
    e[0] = p.s % 256; e[1] = p.s % 256; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);  // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(p.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += p.png.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.png)]);
}

const out = path.join(__dirname, '..', 'icon.ico');
fs.writeFileSync(out, buildIco([64, 32, 16]));
console.log('icon.ico 已生成 →', out, fs.statSync(out).size, 'bytes');
