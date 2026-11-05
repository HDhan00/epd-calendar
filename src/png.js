/**
 * 极简 PNG 编码器（纯 JS，零依赖）
 *
 * 用途：把量化后的 RGBA 画面变成 base64 data URI，交给 <Image> 预览。
 * 为什么自己写：RN 没有 canvas/getImageData，装 Skia 只为了预览太浪费。
 *
 * 实现方式：zlib 用「存储型 deflate」（BTYPE=00），不做真实压缩，
 * 体积略大但代码只有百来行，且对 768×552 这种数据量完全够用。
 */

import P from './protocol';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  return (~c) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type, data) {
  const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, 4);
  // 长度(4) + type+data(body) + CRC(4)
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 4 + body.length);
  return out;
}

/** 存储型 zlib 流 */
function zlibStore(raw) {
  const blocks = [];
  const MAX = 65535;
  for (let off = 0; off < raw.length; off += MAX) {
    const len = Math.min(MAX, raw.length - off);
    const final = off + len >= raw.length ? 1 : 0;
    const head = new Uint8Array(5);
    head[0] = final; // BFINAL, BTYPE=00
    head[1] = len & 0xff;
    head[2] = (len >> 8) & 0xff;
    head[3] = ~len & 0xff;
    head[4] = (~len >> 8) & 0xff;
    blocks.push(head, raw.subarray(off, off + len));
  }
  const bodyLen = blocks.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(2 + bodyLen + 4);
  out[0] = 0x78; // CMF
  out[1] = 0x01; // FLG (no dict, 32K window)
  let o = 2;
  blocks.forEach((b) => { out.set(b, o); o += b.length; });
  out.set(u32(adler32(raw)), o);
  return out;
}

/**
 * @param {Uint8Array|Uint8ClampedArray} rgba 长度 w*h*4
 * @param {number} w
 * @param {number} h
 * @returns {Uint8Array} PNG 字节
 */
export function encodePNG(rgba, w, h) {
  // 扫描行：每行前加 1 字节 filter=0
  const rowLen = w * 4;
  const raw = new Uint8Array((rowLen + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (rowLen + 1)] = 0;
    raw.set(rgba.subarray(y * rowLen, (y + 1) * rowLen), y * (rowLen + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32(w), 0);
  ihdr.set(u32(h), 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const chunks = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStore(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  chunks.forEach((c) => { out.set(c, o); o += c.length; });
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

/** RGBA → data URI（可直接给 <Image source={{uri}} />） */
export function rgbaToDataUri(rgba, w, h) {
  const png = encodePNG(rgba, w, h);
  return `data:image/png;base64,${bytesToBase64(png)}`;
}

/** 2 倍下采样，预览用，省内存 */
export function downsampleRGBA(rgba, w, h, factor = 2) {
  const nw = Math.floor(w / factor);
  const nh = Math.floor(h / factor);
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      // 取 factor×factor 块的平均值
      let r = 0; let g = 0; let b = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const s = ((y * factor + dy) * w + (x * factor + dx)) * 4;
          r += rgba[s]; g += rgba[s + 1]; b += rgba[s + 2];
        }
      }
      const n = factor * factor;
      const d = (y * nw + x) * 4;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}
