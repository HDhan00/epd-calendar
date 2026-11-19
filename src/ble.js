/**
 * BLE 传输层（react-native-ble-plx 版）
 *
 * 与小程序版 src/ble.js 语义完全一致，只把传输换成 ble-plx：
 *   wx.*            → BleManager / Device
 *   ArrayBuffer     → base64 字符串
 *   onBLECharacteristicValueChange → monitorCharacteristicForService
 *
 * 注意：Expo Go 不支持原生模块，必须用 EAS Build 出的 development build 或独立 APK。
 */

import { BleManager } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import P from './protocol';
import { bytesToBase64, base64ToBytes } from './base64';

export const UUID = {
  SERVICE: '7B4D0001-6A6C-4C61-9F20-65706463616C',
  CONTROL: '7B4D0002-6A6C-4C61-9F20-65706463616C',
  NOTIFY: '7B4D0003-6A6C-4C61-9F20-65706463616C',
  IMAGE: '7B4D0004-6A6C-4C61-9F20-65706463616C',
};

export const DEVICE_NAME = 'EPD-Calendar';

const FRAME_OVERHEAD = 10;
const PHOTO_DATA_OVERHEAD = FRAME_OVERHEAD + 4;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (s) => String(s || '').toUpperCase();

export default class EpdBle {
  constructor() {
    this.manager = new BleManager();
    this.device = null;
    this.serviceId = null;
    this.parser = new P.FrameParser();
    this.seq = 0;
    this.pending = new Map();
    this.mtu = 23;
    this.connected = false;
    this.onStateChange = null;
    this.monitorSub = null;
    // 最近命令的收发记录，供界面把"设备到底回了什么"摊开给人看
    this.trace = [];
  }

  /* -------------------------------------------------------------- 扫描 ---- */

  waitForPowerOn(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const sub = this.manager.onStateChange((state) => {
        if (state === 'PoweredOn') {
          sub.remove();
          resolve();
        } else if (Date.now() - t0 > timeoutMs) {
          sub.remove();
          reject(new Error('蓝牙未打开，请先在系统设置里打开蓝牙'));
        }
      }, true);
    });
  }

  /**
   * 扫描设备。
   * @param {(list:Array)=>void} onUpdate 每发现一台设备回调
   * @param {number} durationMs 扫描时长
   * @param {{all?: boolean}} opts all=true 时不加 Service 过滤，列出附近全部 BLE 设备（排查用）
   */
  scan(onUpdate, durationMs = 10000, opts = {}) {
    const found = new Map();
    const all = !!opts.all;
    return new Promise(async (resolve, reject) => {
      try {
        await this.waitForPowerOn();
      } catch (e) {
        reject(e);
        return;
      }

      // 同一时刻只能存在一个扫描会话
      try { this.manager.stopDeviceScan(); } catch (e) { /* ignore */ }

      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { this.manager.stopDeviceScan(); } catch (e) { /* ignore */ }
        if (err) reject(err);
        else resolve(value);
      };

      const timer = setTimeout(() => finish(null, Array.from(found.values())), durationMs);

      // all 模式传 null（不按 Service 过滤）
      // 注意：startDeviceScan 可能在同步阶段抛（例如 manager 已销毁），
      // 那时 timer 已经建好，必须走 finish 收尾，否则要等超时才释放
      const onDiscover = (err, dev) => {
        if (err) {
          finish(new Error(err.message || '扫描失败'));
          return;
        }
        if (!dev) return;
        const name = dev.localName || dev.name || '';
        const services = (dev.serviceUUIDs || []).map((u) => String(u).toUpperCase());
        // 判断是不是我们的设备：名字匹配，或广播里带了私有 Service UUID
        const isEpd = name === DEVICE_NAME || services.includes(UUID.SERVICE);
        if (found.has(dev.id)) {
          const prev = found.get(dev.id);
          if (prev.rssi === dev.rssi) return;
        }
        found.set(dev.id, {
          id: dev.id,
          name: name || '(未命名)',
          rssi: dev.rssi,
          services,
          isEpd,
        });
        if (onUpdate) onUpdate(Array.from(found.values()));
      };

      try {
        this.manager.startDeviceScan(all ? null : [UUID.SERVICE], { allowDuplicates: false }, onDiscover);
      } catch (e) {
        finish(new Error(`启动扫描失败：${e.message || e}`));
      }
    });
  }

  stopScan() {
    this.manager.stopDeviceScan();
  }

  /* -------------------------------------------------------------- 连接 ---- */

  async connect(id) {
    // 扫描和连接同时进行在部分机型上会互相干扰，先停扫描
    try { this.manager.stopDeviceScan(); } catch (e) { /* ignore */ }
    await this.disconnect().catch(() => {});
    this.parser = new P.FrameParser();

    const device = await this.manager.connectToDevice(id, { timeout: 12000 });

    try {
      await device.discoverAllServicesAndCharacteristics();
      this.device = device;
      this.serviceId = this._findServiceId(device);
      await this._subscribe();
      await this._requestMtu();
    } catch (e) {
      // 连上了但不是我们的设备（比如"扫描全部设备"时点错），
      // 必须把底层连接回收，否则设备会一直占着这一个 BLE 连接槽位
      try { await device.cancelConnection(); } catch (err) { /* ignore */ }
      this.device = null;
      this.connected = false;
      throw new Error(
        e && e.message && /私有服务/.test(e.message)
          ? e.message
          : `连接已建立但初始化失败：${(e && e.message) || '未知错误'}`,
      );
    }
    this.connected = true;

    if (this.disconnectSub) {
      try { this.disconnectSub.remove(); } catch (e) { /* ignore */ }
    }
    this.disconnectSub = device.onDisconnected(() => {
      this.connected = false;
      this._failAllPending(new Error('设备已断开'));
      if (this.onStateChange) this.onStateChange(false);
    });

    if (this.onStateChange) this.onStateChange(true);
    return true;
  }

  _findServiceId(device) {
    // ble-plx 返回的 UUID 是小写的；协议里是大写，比较时统一
    const services = device.serviceUUIDs || [];
    const hit = services.find((u) => up(u) === UUID.SERVICE);
    return hit || UUID.SERVICE.toLowerCase();
  }

  async _subscribe() {
    this.monitorSub = this.device.monitorCharacteristicForService(
      this.serviceId,
      UUID.NOTIFY.toLowerCase(),
      (err, ch) => {
        if (err || !ch || !ch.value) return;
        this._onNotify(base64ToBytes(ch.value));
      },
    );
    await delay(150);
  }

  async _requestMtu() {
    if (Platform.OS !== 'android') {
      // iOS 由系统协商，ble-plx 不暴露 MTU 查询，按常见值保守处理
      this.mtu = 185;
      return;
    }
    try {
      // 注意：ble-plx 的 requestMTU() 返回的是 Device 对象，不是 MTU 数字。
      // 真正的协商结果要读 device.mtu，直接拿返回值做算术会得到 NaN。
      const dev = await this.device.requestMTU(247);
      const reported = dev && typeof dev.mtu === 'number'
        ? dev.mtu
        : (this.device && typeof this.device.mtu === 'number' ? this.device.mtu : NaN);
      this.mtu = Number.isFinite(reported) && reported >= 23 ? reported : 247;
    } catch (e) {
      this.mtu = 185;
    }
  }

  async disconnect() {
    this.connected = false;
    this._failAllPending(new Error('主动断开'));
    if (this.monitorSub) {
      try { this.monitorSub.remove(); } catch (e) { /* ignore */ }
      this.monitorSub = null;
    }
    if (this.disconnectSub) {
      try { this.disconnectSub.remove(); } catch (e) { /* ignore */ }
      this.disconnectSub = null;
    }
    if (this.device) {
      try { await this.device.cancelConnection(); } catch (e) { /* ignore */ }
      this.device = null;
    }
  }

  destroy() {
    this.disconnect().catch(() => {});
    this.manager.destroy();
  }

  /* ------------------------------------------------------------ 收发 ---- */

  _onNotify(bytes) {
    const frames = this.parser.feed(bytes);
    for (const f of frames) {
      const waiter = this.pending.get(f.seq);
      if (!waiter) continue;
      this.pending.delete(f.seq);
      clearTimeout(waiter.timer);
      waiter.resolve(f);
    }
  }

  _failAllPending(err) {
    for (const [, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.pending.clear();
  }

  static hex(bytes, max = 40) {
    if (!bytes || !bytes.length) return '(空)';
    const n = Math.min(bytes.length, max);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(bytes[i].toString(16).padStart(2, '0'));
    const tail = bytes.length > max ? ` …(+${bytes.length - max})` : '';
    return parts.join(' ') + tail;
  }

  _trace(entry) {
    this.trace.unshift(entry);
    if (this.trace.length > 12) this.trace.length = 12;
  }

  /** 状态码 → 人话 + 该怎么查 */
  static explain(status, cmdName) {
    const map = {
      1: '设备认为这条命令的载荷不合法：长度、字段范围或 CRC 不对（对比下面的十六进制）',
      2: '设备写 NVS/Flash 失败，可能是存储分区问题或擦写次数异常',
      3: '设备当前状态不允许执行这条命令（例如正在刷新、或上传会话状态不对）',
      4: '设备固件不支持这条命令（版本不匹配）',
      5: '设备忙：命令队列已满或正在刷屏，稍后重试',
    };
    const base = map[status.code];
    return base ? `${status.text} —— ${base}` : `未知状态 0x${(status.code >>> 0).toString(16)}`;
  }

  _err(prefix, r) {
    const e = new Error(
      `${prefix}：${EpdBle.explain(r.status)}\n原始回包: ${EpdBle.hex(r.payload, 24)}`,
    );
    e.status = r.status;
    e.raw = r.payload;
    return e;
  }

  nextSeq() {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  /** 每个对外命令执行前都确认底层连接还在，避免 device 为 null 时抛 TypeError */
  _ensureDevice() {
    if (!this.device) {
      this.connected = false;
      if (this.onStateChange) this.onStateChange(false);
      throw new Error('设备未连接（蓝牙可能已断开），请回「设备」页重新连接');
    }
    return this.device;
  }

  /** 供界面在切页时复查：底层连接是否真的还在 */
  isUsable() {
    return !!(this.connected && this.device);
  }

  _write(charUUID, bytes) {
    const dev = this._ensureDevice();
    const b64 = bytesToBase64(bytes);
    return dev.writeCharacteristicWithResponseForService(
      this.serviceId,
      charUUID.toLowerCase(),
      b64,
    );
  }

  async request(type, payload, opts = {}) {
    const timeout = opts.timeout || 6000;
    const channel = opts.channel || 'control';
    const retries = opts.retries === undefined ? 2 : opts.retries;
    const charUUID = channel === 'image' ? UUID.IMAGE : UUID.CONTROL;

    this._ensureDevice();
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const seq = this.nextSeq();
      const frame = P.encodeFrame(type, seq, payload);

      const respPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(seq);
          reject(new Error(`${P.CMD_NAME[type] || '命令'} 响应超时`));
        }, timeout);
        this.pending.set(seq, { resolve, reject, timer });
      });

      const t0 = Date.now();
      try {
        await this._write(charUUID, frame);
        const resp = await respPromise;
        if (resp.type !== (type | P.RESPONSE_BIT)) {
          throw new Error(`响应类型不匹配: 0x${resp.type.toString(16)}`);
        }
        const status = P.statusOf(resp.payload);
        this._trace({
          ts: Date.now(),
          name: P.CMD_NAME[type] || ('0x' + type.toString(16)),
          seq,
          code: status.code,
          ms: Date.now() - t0,
          tx: EpdBle.hex(payload, 16),
          rx: EpdBle.hex(resp.payload, 24),
          hint: status.code === 0 ? '' : EpdBle.explain(status, P.CMD_NAME[type]),
        });
        if (status.code === 5 && attempt < retries) {
          lastErr = new Error(status.text);
          await delay(300 * (attempt + 1));
          continue;
        }
        return { status, payload: resp.payload };
      } catch (e) {
        lastErr = e;
        this._trace({
          ts: Date.now(),
          name: P.CMD_NAME[type] || ('0x' + type.toString(16)),
          seq,
          code: -1,
          ms: Date.now() - t0,
          tx: EpdBle.hex(payload, 16),
          rx: '',
          hint: e.message,
        });
        this.pending.delete(seq);
        if (attempt >= retries) break;
        await delay(200 * (attempt + 1));
      }
    }
    throw lastErr || new Error('请求失败');
  }

  /* ------------------------------------------------------------ 命令 ---- */

  async getInfo() {
    const r = await this.request(P.CMD.GET_INFO, new Uint8Array(0));
    if (r.status.code !== 0) throw this._err('GET_INFO 失败', r);
    return P.parseDeviceInfo(r.payload);
  }

  async setMode(mode) {
    const c = P.cmd.setMode(mode);
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw this._err('设置模式失败', r);
  }

  async setRotation(rotation) {
    const c = P.cmd.setRotation(rotation);
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw this._err('设置旋转失败', r);
  }

  async refresh() {
    const c = P.cmd.refresh();
    const r = await this.request(c.type, c.payload, { timeout: 15000 });
    if (r.status.code !== 0) throw this._err('刷新失败', r);
  }

  async nextPhoto() {
    const c = P.cmd.nextPhoto();
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw this._err('切换照片失败', r);
    return r.payload[1];
  }

  async setTimezone(tz) {
    const c = P.cmd.setTimezone(tz);
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw this._err('设置时区失败', r);
  }

  async setLocation(lat, lon) {
    const c = P.cmd.setLocation(lat, lon);
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw this._err('设置位置失败', r);
  }

  async setWifi(ssid, password) {
    const c = P.cmd.setWifi(ssid, password);
    const r = await this.request(c.type, c.payload, { timeout: 12000 });
    if (r.status.code !== 0) throw this._err('配网失败', r);
  }

  async weatherRefresh() {
    const c = P.cmd.weatherRefresh();
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw this._err('天气刷新失败', r);
  }

  /** 手动设置设备时间（需要固件支持 0x0F 扩展命令） */
  async setTime(unixSec) {
    const c = P.cmd.setTime(unixSec);
    const r = await this.request(c.type, c.payload);
    if (r.status.code === 4) {
      throw new Error('设备固件不支持设置时间（需要刷带 SET_TIME 的新固件）');
    }
    if (r.status.code !== 0) throw this._err('设置设备时间失败', r);
    return true;
  }

  async setTodayPlan(text) {
    const c = P.cmd.setTodayPlan(text);
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw this._err('设置今日计划失败', r);
  }

  async photoAbort() {
    const c = P.cmd.photoAbort();
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw this._err('取消上传失败', r);
  }

  getChunkSize() {
    // 兜底：任何情况下都不允许返回 NaN（NaN 会让 slice 切出 0 字节，
    // 设备收到只有 offset 的 PHOTO_DATA 会回“参数/CRC 无效”）
    const mtu = Number(this.mtu);
    const safe = Number.isFinite(mtu) && mtu >= 23 ? mtu : 23;
    return Math.max(20, safe - 3 - PHOTO_DATA_OVERHEAD);
  }

  /* ---------------------------------------------------------- 照片上传 ---- */

  async uploadPhoto(frame, slot, opts = {}) {
    if (frame.length !== P.PANEL.FRAME_BYTES) {
      throw new Error(`画面必须是 ${P.PANEL.FRAME_BYTES} 字节，当前 ${frame.length}`);
    }
    const total = frame.length;
    const crc = P.crc32ieee(frame);
    const photoId = (Date.now() >>> 0) % 0xffffffff || 1;
    const maxChunk = this.getChunkSize();
    if (!Number.isFinite(maxChunk) || maxChunk < 1) {
      throw new Error(`MTU 异常（${this.mtu}），单片长度 ${maxChunk}，无法上传`);
    }

    const begin = P.cmd.photoBegin(photoId, slot, total, crc);
    let r = await this.request(begin.type, begin.payload, { timeout: 10000 });
    if (r.status.code !== 0) throw this._err('开始上传失败', r);

    let offset = P.readU32LE(r.payload, 2);
    if (opts.onProgress) opts.onProgress(offset, total);

    while (offset < total) {
      if (opts.shouldAbort && opts.shouldAbort()) {
        await this.photoAbort().catch(() => {});
        throw new Error('已取消上传');
      }
      const chunk = frame.slice(offset, Math.min(offset + maxChunk, total));
      const data = P.cmd.photoData(offset, chunk);
      r = await this.request(data.type, data.payload, {
        channel: 'image',
        timeout: 10000,
        retries: 3,
      });
      if (r.status.code !== 0) throw this._err('数据写入失败', r);
      const next = P.readU32LE(r.payload, 1);
      if (next <= offset && offset + chunk.length < total) {
        throw new Error(`设备未接收偏移 ${offset} 之后的数据`);
      }
      offset = next;
      if (opts.onProgress) opts.onProgress(offset, total);
    }

    const end = P.cmd.photoEnd(crc);
    r = await this.request(end.type, end.payload, { timeout: 20000 });
    if (r.status.code !== 0) throw this._err('提交失败', r);
    return {
      slot: r.payload[1],
      photoId: P.readU32LE(r.payload, 2),
      totalLen: P.readU32LE(r.payload, 6),
      crc32: crc,
    };
  }
}
