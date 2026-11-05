/**
 * base64 ↔ Uint8Array。BLE 层（react-native-ble-plx）收发都用 base64 字符串，
 * 而协议层是字节数组，这里做边界转换。
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < CHARS.length; i++) t[CHARS.charCodeAt(i)] = i;
  t['='.charCodeAt(0)] = 0;
  return t;
})();

function bytesToBase64(bytes) {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += CHARS[b0 >> 2];
    out += CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? CHARS[b2 & 63] : '=';
  }
  return out;
}

function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4) - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = LOOKUP[clean.charCodeAt(i)];
    const c1 = LOOKUP[clean.charCodeAt(i + 1)];
    const c2 = LOOKUP[clean.charCodeAt(i + 2)];
    const c3 = LOOKUP[clean.charCodeAt(i + 3)];
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (o < out.length) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (o < out.length) out[o++] = ((c2 & 3) << 6) | c3;
  }
  return out;
}

module.exports = { bytesToBase64, base64ToBytes };
