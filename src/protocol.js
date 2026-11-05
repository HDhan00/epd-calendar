/**
 * EPD BLE 私有协议 v1 —— 帧编解码与命令封装
 *
 * 严格对照固件 main/ble/ble_protocol.c 与 main/ble/ble_commands.c 实现：
 *   帧：45 50 | 01 | type | seq(le16) | len(le16) | payload | crc16(le16)
 *   CRC16/CCITT-FALSE：init=0xFFFF, poly=0x1021, 不反射, 无最终异或，覆盖帧头+payload
 *   CRC32 IEEE/ZIP：init=0xFFFFFFFF, 反射多项式 0xEDB88320, 结果取反
 */

const MAGIC0 = 0x45; // 'E'
const MAGIC1 = 0x50; // 'P'
const VERSION = 0x01;
const RESPONSE_BIT = 0x80;
const HEADER_SIZE = 8;
const CRC_SIZE = 2;
const MAX_PAYLOAD = 1024;

// 命令类型
const CMD = {
  GET_INFO: 0x01,
  SET_ROTATION: 0x02,
  SET_MODE: 0x03,
  REFRESH: 0x04,
  NEXT_PHOTO: 0x05,
  SET_TIMEZONE: 0x06,
  SET_LOCATION: 0x07,
  WIFI_SET_CREDENTIALS: 0x08,
  WEATHER_REFRESH: 0x09,
  PHOTO_BEGIN: 0x0a,
  PHOTO_DATA: 0x0b,
  PHOTO_END: 0x0c,
  PHOTO_ABORT: 0x0d,
  SET_TODAY_PLAN: 0x0e,
};

const CMD_NAME = {
  0x01: 'GET_INFO', 0x02: 'SET_ROTATION', 0x03: 'SET_MODE', 0x04: 'REFRESH',
  0x05: 'NEXT_PHOTO', 0x06: 'SET_TIMEZONE', 0x07: 'SET_LOCATION',
  0x08: 'WIFI_SET_CREDENTIALS', 0x09: 'WEATHER_REFRESH', 0x0a: 'PHOTO_BEGIN',
  0x0b: 'PHOTO_DATA', 0x0c: 'PHOTO_END', 0x0d: 'PHOTO_ABORT', 0x0e: 'SET_TODAY_PLAN',
};

// 状态码（Payload 首字节）
const STATUS = {
  0x00: { code: 0, text: '成功' },
  0x01: { code: 1, text: '参数/CRC 无效' },
  0x02: { code: 2, text: 'NVS/Flash 读写错误' },
  0x03: { code: 3, text: '当前状态不允许' },
  0x04: { code: 4, text: '不支持该命令' },
  0x05: { code: 5, text: '资源忙/队列满' },
};

// 显示模式 / 旋转
const MODE = { CALENDAR: 0, PHOTO: 1, CALENDAR_PHOTO: 2, STATUS: 3 };
const MODE_TEXT = ['日历', '相框', '日历+相框', '状态页'];
const ROTATION_TEXT = ['0°（横屏正向）', '90°（逆时针）', '180°（倒置）', '270°（顺时针）'];

// 屏幕参数（固件 epd_config.h）
const PANEL = {
  WIDTH: 768,
  HEIGHT: 552,
  BYTES_PER_LINE: 192,
  FRAME_BYTES: 105984,
  SLOT_COUNT: 4,
  // 2bpp 颜色码，不可随意置换
  BLACK: 0x00,
  WHITE: 0x01,
  YELLOW: 0x02,
  RED: 0x03,
};

const LIMITS = {
  SSID_MAX: 32,
  PASSWORD_MAX: 64,
  TIMEZONE_MAX: 63,
  TODAY_PLAN_MAX: 30,
};

/* ------------------------------------------------------------------ CRC ---- */

function crc16ccitt(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

let crc32Table = null;
function crc32ieee(bytes) {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crc32Table[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ bytes[i]) & 0xff];
  }
  return (~crc) >>> 0;
}

/* -------------------------------------------------------------- 字节工具 ---- */

function readU16LE(b, o) { return (b[o] | (b[o + 1] << 8)) & 0xffff; }
function readU32LE(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function writeU16LE(b, o, v) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}
function writeU32LE(b, o, v) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

// UTF-8 编码（小程序没有 TextEncoder）
function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) { out += String.fromCharCode(b0); continue; }
    if (b0 >= 0xc0 && b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else {
      const cp = ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
                 ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
  }
  return out;
}

function utf8ByteLength(str) { return utf8Encode(str).length; }

/* ------------------------------------------------------------------ 帧 ------ */

function encodeFrame(type, seq, payload) {
  const p = payload || new Uint8Array(0);
  if (p.length > MAX_PAYLOAD) throw new Error('payload 超过 1024 字节');
  const total = HEADER_SIZE + p.length + CRC_SIZE;
  const out = new Uint8Array(total);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = VERSION;
  out[3] = type & 0xff;
  writeU16LE(out, 4, seq & 0xffff);
  writeU16LE(out, 6, p.length);
  out.set(p, HEADER_SIZE);
  writeU16LE(out, HEADER_SIZE + p.length, crc16ccitt(out.subarray(0, HEADER_SIZE + p.length)));
  return out;
}

/**
 * 流式解帧器：Notify 可能把一帧拆成多条通知，也可能多条粘在一起。
 * 用法：parser.feed(chunk) -> [frame...]
 */
class FrameParser {
  constructor() {
    this.buf = new Uint8Array(0);
    this.dropped = 0;
  }

  feed(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const frames = [];
    for (;;) {
      // 找帧头
      let start = -1;
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === MAGIC0 && this.buf[i + 1] === MAGIC1) { start = i; break; }
      }
      if (start < 0) {
        // 保留最后 1 字节，防止 magic 被切断
        this.buf = this.buf.slice(Math.max(0, this.buf.length - 1));
        break;
      }
      if (start > 0) {
        this.dropped++;
        this.buf = this.buf.slice(start);
      }
      if (this.buf.length < HEADER_SIZE) break;
      if (this.buf[2] !== VERSION) { this.buf = this.buf.slice(2); this.dropped++; continue; }
      const len = readU16LE(this.buf, 6);
      if (len > MAX_PAYLOAD) { this.buf = this.buf.slice(2); this.dropped++; continue; }
      const frameLen = HEADER_SIZE + len + CRC_SIZE;
      if (this.buf.length < frameLen) break;
      const crcWant = readU16LE(this.buf, frameLen - 2);
      const crcGot = crc16ccitt(this.buf.subarray(0, frameLen - 2));
      if (crcWant !== crcGot) {
        this.buf = this.buf.slice(2);
        this.dropped++;
        continue;
      }
      frames.push({
        type: this.buf[3],
        seq: readU16LE(this.buf, 4),
        payload: this.buf.slice(HEADER_SIZE, HEADER_SIZE + len),
      });
      this.buf = this.buf.slice(frameLen);
    }
    return frames;
  }
}

/* ------------------------------------------------------------ 命令封装 ------ */

const cmd = {
  getInfo: () => ({ type: CMD.GET_INFO, payload: new Uint8Array(0) }),

  setRotation: (r) => {
    if (r < 0 || r > 3) throw new Error('旋转只能是 0..3');
    return { type: CMD.SET_ROTATION, payload: new Uint8Array([r]) };
  },

  setMode: (m) => {
    if (m < 0 || m > 3) throw new Error('模式只能是 0..3');
    return { type: CMD.SET_MODE, payload: new Uint8Array([m]) };
  },

  refresh: () => ({ type: CMD.REFRESH, payload: new Uint8Array(0) }),
  nextPhoto: () => ({ type: CMD.NEXT_PHOTO, payload: new Uint8Array(0) }),
  weatherRefresh: () => ({ type: CMD.WEATHER_REFRESH, payload: new Uint8Array(0) }),
  photoAbort: () => ({ type: CMD.PHOTO_ABORT, payload: new Uint8Array(0) }),

  setTimezone: (tz) => {
    // 固件字符集 [A-Za-z0-9_+./-]，拒绝空段与首尾 '/'
    const s = String(tz || '');
    if (s.length < 1 || s.length > LIMITS.TIMEZONE_MAX) throw new Error('时区长度需 1..63');
    if (!/^[A-Za-z0-9_+./-]+$/.test(s)) throw new Error('时区只允许 A-Za-z0-9_+./-');
    if (s.startsWith('/') || s.endsWith('/') || s.includes('//')) throw new Error('时区分段非法');
    return { type: CMD.SET_TIMEZONE, payload: utf8Encode(s) };
  },

  setLocation: (lat, lon) => {
    if (!(lat >= -90 && lat <= 90)) throw new Error('纬度需在 ±90 度内');
    if (!(lon >= -180 && lon <= 180)) throw new Error('经度需在 ±180 度内');
    const p = new Uint8Array(8);
    // i32 小端（负数用补码）
    writeU32LE(p, 0, Math.round(lat * 1e7) >>> 0);
    writeU32LE(p, 4, Math.round(lon * 1e7) >>> 0);
    return { type: CMD.SET_LOCATION, payload: p };
  },

  setWifi: (ssid, password) => {
    const s = utf8Encode(String(ssid || ''));
    const w = utf8Encode(String(password || ''));
    if (s.length === 0 && w.length === 0) {
      // 清除凭据：[00, 00]
      return { type: CMD.WIFI_SET_CREDENTIALS, payload: new Uint8Array([0, 0]) };
    }
    if (s.length < 1 || s.length > LIMITS.SSID_MAX) throw new Error('SSID 需 1..32 字节');
    if (w.length > LIMITS.PASSWORD_MAX) throw new Error('密码最多 64 字节');
    const all = new Uint8Array(2 + s.length + w.length);
    all[0] = s.length;
    all[1] = w.length;
    all.set(s, 2);
    all.set(w, 2 + s.length);
    // 固件拒绝 NUL、控制字符与 DEL
    for (let i = 2; i < all.length; i++) {
      if (all[i] < 0x20 || all[i] === 0x7f) throw new Error('SSID/密码不能含控制字符');
    }
    return { type: CMD.WIFI_SET_CREDENTIALS, payload: all };
  },

  setTodayPlan: (text) => {
    const b = utf8Encode(String(text || ''));
    if (b.length > LIMITS.TODAY_PLAN_MAX) {
      throw new Error(`今日计划最多 ${LIMITS.TODAY_PLAN_MAX} 字节（当前 ${b.length}）`);
    }
    return { type: CMD.SET_TODAY_PLAN, payload: b };
  },

  photoBegin: (photoId, slot, totalLen, crc32) => {
    if (slot < 0 || slot >= PANEL.SLOT_COUNT) throw new Error('槽位 0..3');
    const p = new Uint8Array(13);
    writeU32LE(p, 0, photoId);
    p[4] = slot;
    writeU32LE(p, 5, totalLen);
    writeU32LE(p, 9, crc32);
    return { type: CMD.PHOTO_BEGIN, payload: p };
  },

  photoData: (offset, bytes) => {
    const p = new Uint8Array(4 + bytes.length);
    writeU32LE(p, 0, offset);
    p.set(bytes, 4);
    return { type: CMD.PHOTO_DATA, payload: p };
  },

  photoEnd: (crc32) => {
    const p = new Uint8Array(4);
    writeU32LE(p, 0, crc32);
    return { type: CMD.PHOTO_END, payload: p };
  },
};

/* ------------------------------------------------------------ 响应解析 ------ */

function statusOf(payload) {
  const s = STATUS[payload[0]] || { code: -1, text: `未知状态 0x${payload[0].toString(16)}` };
  return s;
}

// GET_INFO 响应体（状态码之后）
function parseDeviceInfo(payload) {
  if (payload.length < 31) throw new Error('GET_INFO 数据过短');
  let o = 1; // 跳过状态码
  const info = {};
  info.schema = payload[o++];
  info.mode = payload[o++];
  info.rotation = payload[o++];
  info.photoSlot = payload[o++];
  const flags = payload[o++];
  info.wifiConnected = !!(flags & 1);
  info.ntpSynced = !!(flags & 2);
  info.weatherValid = !!(flags & 4);
  info.weatherStale = !!(flags & 8);
  info.wifiSaved = !!(flags & 16);
  info.wifiTxQdbm = (payload[o++] << 24) >> 24; // i8
  info.bleTxDbm = (payload[o++] << 24) >> 24;
  info.autoRefreshSec = readU32LE(payload, o); o += 4;
  info.latitudeE7 = readU32LE(payload, o) | 0; o += 4;
  info.longitudeE7 = readU32LE(payload, o) | 0; o += 4;
  info.temperatureC10 = (readU16LE(payload, o) << 16) >> 16; o += 2;
  // u64 时间戳：JS 用 Number 足够（Unix 秒）
  info.weatherUpdatedUnix = readU32LE(payload, o) + readU32LE(payload, o + 4) * 4294967296;
  o += 8;
  const tzLen = payload[o++];
  info.timezone = utf8Decode(payload.slice(o, o + tzLen)); o += tzLen;
  const planLen = payload[o++];
  info.todayPlan = utf8Decode(payload.slice(o, o + planLen)); o += planLen;
  info.uploadActive = !!payload[o++];
  info.uploadSlot = payload[o++];
  info.uploadPhotoId = readU32LE(payload, o); o += 4;
  info.uploadTotalLen = readU32LE(payload, o); o += 4;
  info.uploadNextOffset = readU32LE(payload, o); o += 4;
  return info;
}

module.exports = {
  MAGIC0, MAGIC1, VERSION, RESPONSE_BIT, HEADER_SIZE, CRC_SIZE, MAX_PAYLOAD,
  CMD, CMD_NAME, STATUS, MODE, MODE_TEXT, ROTATION_TEXT, PANEL, LIMITS,
  crc16ccitt, crc32ieee, encodeFrame, FrameParser,
  utf8Encode, utf8Decode, utf8ByteLength,
  readU16LE, readU32LE, writeU16LE, writeU32LE,
  cmd, statusOf, parseDeviceInfo,
};
