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
   * @param {(list:Array)=>void} onUpdate 每发现一台设备回调
   * @param {number} durationMs
   */
  scan(onUpdate, durationMs = 10000) {
    const found = new Map();
    return new Promise(async (resolve, reject) => {
      try {
        await this.waitForPowerOn();
      } catch (e) {
        reject(e);
        return;
      }

      const timer = setTimeout(() => {
        this.manager.stopDeviceScan();
        resolve(Array.from(found.values()));
      }, durationMs);

      this.manager.startDeviceScan([UUID.SERVICE], { allowDuplicates: false }, (err, dev) => {
        if (err) {
          clearTimeout(timer);
          this.manager.stopDeviceScan();
          reject(new Error(err.message || '扫描失败'));
          return;
        }
        if (!dev) return;
        const name = dev.localName || dev.name || '';
        if (found.has(dev.id)) return;
        found.set(dev.id, { id: dev.id, name: name || DEVICE_NAME, rssi: dev.rssi });
        if (onUpdate) onUpdate(Array.from(found.values()));
      });
    });
  }

  stopScan() {
    this.manager.stopDeviceScan();
  }

  /* -------------------------------------------------------------- 连接 ---- */

  async connect(id) {
    await this.disconnect().catch(() => {});
    this.parser = new P.FrameParser();

    const device = await this.manager.connectToDevice(id, { timeout: 12000 });
    await device.discoverAllServicesAndCharacteristics();
    this.device = device;
    this.serviceId = up(device.id) && this._findServiceId(device);

    await this._subscribe();
    await this._requestMtu();
    this.connected = true;

    device.onDisconnected(() => {
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
      const mtu = await this.device.requestMTU(247);
      this.mtu = mtu || 247;
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

  nextSeq() {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  _write(charUUID, bytes) {
    const b64 = bytesToBase64(bytes);
    return this.device.writeCharacteristicWithResponseForService(
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

      try {
        await this._write(charUUID, frame);
        const resp = await respPromise;
        if (resp.type !== (type | P.RESPONSE_BIT)) {
          throw new Error(`响应类型不匹配: 0x${resp.type.toString(16)}`);
        }
        const status = P.statusOf(resp.payload);
        if (status.code === 5 && attempt < retries) {
          lastErr = new Error(status.text);
          await delay(300 * (attempt + 1));
          continue;
        }
        return { status, payload: resp.payload };
      } catch (e) {
        lastErr = e;
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
    if (r.status.code !== 0) throw new Error(`GET_INFO 失败：${r.status.text}`);
    return P.parseDeviceInfo(r.payload);
  }

  async setMode(mode) {
    const c = P.cmd.setMode(mode);
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw new Error(`设置模式失败：${r.status.text}`);
  }

  async setRotation(rotation) {
    const c = P.cmd.setRotation(rotation);
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw new Error(`设置旋转失败：${r.status.text}`);
  }

  async refresh() {
    const c = P.cmd.refresh();
    const r = await this.request(c.type, c.payload, { timeout: 15000 });
    if (r.status.code !== 0) throw new Error(`刷新失败：${r.status.text}`);
  }

  async nextPhoto() {
    const c = P.cmd.nextPhoto();
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw new Error(`切换照片失败：${r.status.text}`);
    return r.payload[1];
  }

  async setTimezone(tz) {
    const c = P.cmd.setTimezone(tz);
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw new Error(`设置时区失败：${r.status.text}`);
  }

  async setLocation(lat, lon) {
    const c = P.cmd.setLocation(lat, lon);
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw new Error(`设置位置失败：${r.status.text}`);
  }

  async setWifi(ssid, password) {
    const c = P.cmd.setWifi(ssid, password);
    const r = await this.request(c.type, c.payload, { timeout: 12000 });
    if (r.status.code !== 0) throw new Error(`配网失败：${r.status.text}`);
  }

  async weatherRefresh() {
    const c = P.cmd.weatherRefresh();
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw new Error(`天气刷新失败：${r.status.text}`);
  }

  async setTodayPlan(text) {
    const c = P.cmd.setTodayPlan(text);
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw new Error(`设置今日计划失败：${r.status.text}`);
  }

  async photoAbort() {
    const c = P.cmd.photoAbort();
    const r = await this.request(c.type, c.payload);
    if (r.status.code !== 0) throw new Error(`取消上传失败：${r.status.text}`);
  }

  getChunkSize() {
    return Math.max(20, this.mtu - 3 - PHOTO_DATA_OVERHEAD);
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

    const begin = P.cmd.photoBegin(photoId, slot, total, crc);
    let r = await this.request(begin.type, begin.payload, { timeout: 10000 });
    if (r.status.code !== 0) throw new Error(`开始上传失败：${r.status.text}`);

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
      if (r.status.code !== 0) throw new Error(`数据写入失败：${r.status.text}`);
      const next = P.readU32LE(r.payload, 1);
      if (next <= offset && offset + chunk.length < total) {
        throw new Error(`设备未接收偏移 ${offset} 之后的数据`);
      }
      offset = next;
      if (opts.onProgress) opts.onProgress(offset, total);
    }

    const end = P.cmd.photoEnd(crc);
    r = await this.request(end.type, end.payload, { timeout: 20000 });
    if (r.status.code !== 0) throw new Error(`提交失败：${r.status.text}`);
    return {
      slot: r.payload[1],
      photoId: P.readU32LE(r.payload, 2),
      totalLen: P.readU32LE(r.payload, 6),
      crc32: crc,
    };
  }
}
