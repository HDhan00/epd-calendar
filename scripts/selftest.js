/**
 * 协议自测（CI 用，零依赖，node scripts/selftest.js）
 *
 * 只测纯 JS 部分：帧编解码、CRC、命令构造、GET_INFO 解析、四色量化与打包。
 * 目的是在触发 EAS 云构建（要花额度）之前，先把协议层的低级错误挡掉。
 *
 * protocol.js / image.js 是 CommonJS，可以直接 require。
 */

const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'protocol.js'));
const IMG = require(path.join(__dirname, '..', 'src', 'image.js'));

let failures = 0;

function ok(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}

function eq(actual, expected, msg) {
  ok(actual === expected, `${msg}（得到 ${actual}，期望 ${expected}）`);
}

/* ------------------------------------------------------------------ CRC -- */

console.log('\n[1] CRC 标准向量');
const vec = new Uint8Array([...Buffer.from('123456789')]);
eq(P.crc16ccitt(vec).toString(16), '29b1', 'CRC16/CCITT-FALSE');
eq(P.crc32ieee(vec).toString(16), 'cbf43926', 'CRC32 IEEE');

/* ------------------------------------------------------------------ 帧 --- */

console.log('\n[2] 帧编解码');
const frame = P.encodeFrame(P.CMD.SET_ROTATION, 0x1234, new Uint8Array([2]));
eq(Buffer.from(frame).toString('hex'), '45500102341201000277ac', '固定帧字节');

const parser = new P.FrameParser();
let out = [];
for (let i = 0; i < frame.length; i += 3) out = out.concat(parser.feed(frame.slice(i, i + 3)));
eq(out.length, 1, '3 字节分片能拼回一帧');
eq(out[0].seq, 0x1234, '序号正确');

const parser2 = new P.FrameParser();
const two = parser2.feed(new Uint8Array([
  ...frame,
  ...P.encodeFrame(P.CMD.REFRESH, 7, new Uint8Array(0)),
]));
eq(two.length, 2, '粘包能解出两帧');

const parser3 = new P.FrameParser();
const broken = frame.slice();
broken[broken.length - 1] ^= 0xff; // 破坏 CRC
eq(parser3.feed(broken).length, 0, 'CRC 错误的帧被丢弃');

/* --------------------------------------------------------------- 命令 --- */

console.log('\n[3] 命令构造');
eq(P.cmd.setMode(3).payload[0], 3, 'SET_MODE payload');
eq(P.cmd.setRotation(2).payload[0], 2, 'SET_ROTATION payload');

const loc = P.cmd.setLocation(-33.8688, 151.2093);
eq(loc.payload.length, 8, 'SET_LOCATION 8 字节');
eq(P.readU32LE(loc.payload, 0) | 0, Math.round(-33.8688 * 1e7), '负纬度按 i32 补码');

const begin = P.cmd.photoBegin(0xdeadbeef, 2, P.PANEL.FRAME_BYTES, 0x12345678);
eq(begin.payload.length, 13, 'PHOTO_BEGIN 13 字节（无对齐填充）');
eq(begin.payload[4], 2, 'PHOTO_BEGIN 槽位在第 5 字节');

const wifi = P.cmd.setWifi('abc', 'pw');
eq(wifi.payload[0], 3, 'WIFI ssid_len');
eq(wifi.payload[1], 2, 'WIFI pwd_len');
eq(wifi.payload.length, 7, 'WIFI 总长度 = 2+3+2');

let threw = false;
try { P.cmd.setTodayPlan('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'); } catch (e) { threw = true; }
ok(threw, '今日计划超 30 字节被拦截');

threw = false;
try { P.cmd.setTimezone('Asia//Shanghai'); } catch (e) { threw = true; }
ok(threw, '时区空段被拦截');

/* ------------------------------------------------------------ GET_INFO -- */

console.log('\n[4] GET_INFO 解析');
const b = [];
const u32 = (v) => { const t = new Uint8Array(4); P.writeU32LE(t, 0, v); b.push(...t); };
const u16 = (v) => b.push(v & 0xff, (v >> 8) & 0xff);
b.push(0, 1, 2, 1, 3, 0b10111, 0xa8, 6); // 状态/schema/mode/rot/slot/flags/wifiTx/bleTx
u32(900); u32(312304000); u32(1214737000); u16(234); u32(1793000000); u32(0);
const tz = Buffer.from('Asia/Shanghai');
b.push(tz.length, ...tz);
const plan = Buffer.from('开会');
b.push(plan.length, ...plan);
b.push(0, 0xff); u32(0); u32(0); u32(0);

const info = P.parseDeviceInfo(new Uint8Array(b));
eq(info.mode, 2, 'mode');
eq(info.rotation, 1, 'rotation');
eq(info.wifiTxQdbm, -88, 'Wi-Fi 功率按 i8 解析');
eq(info.temperatureC10, 234, '温度 23.4');
eq(info.timezone, 'Asia/Shanghai', '时区字符串');
eq(info.todayPlan, '开会', '今日计划字符串');
eq(info.uploadActive, false, '无上传');
eq(info.uploadSlot, 0xff, '无上传时槽位 0xff');

/* -------------------------------------------------------------- 图像 ---- */

console.log('\n[5] 量化与打包');
const W = P.PANEL.WIDTH;
const H = P.PANEL.HEIGHT;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    rgba[i] = (x * 255) / W;
    rgba[i + 1] = (y * 255) / H;
    rgba[i + 2] = 128;
    rgba[i + 3] = 255;
  }
}
const q = IMG.quantize(rgba, W, H);
const packed = IMG.packFrame(q.indices, W, H);
eq(packed.length, P.PANEL.FRAME_BYTES, '帧长度 105984');

const probe = new Uint8Array(W * H);
probe[0] = P.PANEL.BLACK; probe[1] = P.PANEL.WHITE; probe[2] = P.PANEL.YELLOW; probe[3] = P.PANEL.RED;
eq(IMG.packFrame(probe, W, H)[0], 0x1b, '4 像素打包为 0x1b（bit7:6 起）');

const back = IMG.unpackFrameToRGBA(packed, W, H);
let diff = 0;
for (let i = 0; i < W * H; i++) {
  const code = back[i * 4];
  const want = IMG.PALETTE_BY_CODE[q.indices[i]];
  if (code !== want.r) diff++;
}
eq(diff, 0, '打包/解包对称');

/* -------------------------------------------------------------- 汇总 ---- */

console.log('');
if (failures) {
  console.error(`❌ ${failures} 项未通过`);
  process.exit(1);
}
console.log('✅ 全部通过');
