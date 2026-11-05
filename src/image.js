/**
 * 四色墨水屏图像处理
 *
 * 目标格式：768×552、2bpp、4 像素/字节、最左像素占 bit7:6（与固件一致）。
 * 颜色码（epd_config.h，不可置换）：
 *   0x00 黑 / 0x01 白 / 0x02 黄 / 0x03 红
 *
 * 量化算法：Floyd–Steinberg 误差扩散。原因：四色屏只有 4 个色阶，
 * 直接取最近色会出现大面积断层，误差扩散能把照片的中间调表现成网点。
 */

const P = require('./protocol');

// 面板色的近似 RGB。真实颜料会有偏差，这里取"看起来最像"的折中值，
// 想微调可以直接改这张表（改完预览会立刻反映）。
const PALETTE = [
  { code: P.PANEL.WHITE, name: '白', r: 255, g: 255, b: 255 },
  { code: P.PANEL.BLACK, name: '黑', r: 24, g: 24, b: 24 },
  { code: P.PANEL.YELLOW, name: '黄', r: 255, g: 208, b: 0 },
  { code: P.PANEL.RED, name: '红', r: 186, g: 32, b: 44 },
];

const PALETTE_BY_CODE = {};
PALETTE.forEach((c) => { PALETTE_BY_CODE[c.code] = c; });

function nearestIndex(r, g, b) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const c = PALETTE[i];
    // 人眼对绿色最敏感，加权欧氏距离比裸 RGB 更接近观感
    const dr = r - c.r;
    const dg = g - c.g;
    const db = b - c.b;
    const d = 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/**
 * @param {Uint8ClampedArray} rgba 长度 w*h*4
 * @param {number} w
 * @param {number} h
 * @param {object} opts {serpentine:boolean, strength:number}
 * @returns {{indices: Uint8Array, preview: Uint8ClampedArray, stats: object}}
 */
function quantize(rgba, w, h, opts = {}) {
  const serpentine = opts.serpentine !== false;
  const strength = opts.strength === undefined ? 0.85 : opts.strength;

  // 浮点缓冲，误差才能累积
  const buf = new Float32Array(w * h * 3);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    buf[i * 3] = rgba[p];
    buf[i * 3 + 1] = rgba[p + 1];
    buf[i * 3 + 2] = rgba[p + 2];
  }

  const indices = new Uint8Array(w * h);
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };

  const spread = (x, y, er, eg, eb, factor) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 3;
    buf[i] += er * factor * strength;
    buf[i + 1] += eg * factor * strength;
    buf[i + 2] += eb * factor * strength;
  };

  for (let y = 0; y < h; y++) {
    const leftToRight = !serpentine || (y % 2 === 0);
    for (let k = 0; k < w; k++) {
      const x = leftToRight ? k : w - 1 - k;
      const idx = y * w + x;
      const r = buf[idx * 3];
      const g = buf[idx * 3 + 1];
      const b = buf[idx * 3 + 2];
      const pi = nearestIndex(r, g, b);
      const c = PALETTE[pi];
      indices[idx] = c.code;
      counts[c.code]++;

      const er = r - c.r;
      const eg = g - c.g;
      const eb = b - c.b;
      const dir = leftToRight ? 1 : -1;

      // Floyd–Steinberg 核
      spread(x + dir, y, er, eg, eb, 7 / 16);
      spread(x - dir, y + 1, er, eg, eb, 3 / 16);
      spread(x, y + 1, er, eg, eb, 5 / 16);
      spread(x + dir, y + 1, er, eg, eb, 1 / 16);
    }
  }

  // 预览：把量化结果还原成 RGBA，供 canvas 显示
  const preview = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = PALETTE_BY_CODE[indices[i]];
    preview[i * 4] = c.r;
    preview[i * 4 + 1] = c.g;
    preview[i * 4 + 2] = c.b;
    preview[i * 4 + 3] = 255;
  }

  return { indices, preview, stats: counts };
}

/**
 * 量化结果打包成设备帧：4 像素/字节，最左像素在 bit7:6。
 */
function packFrame(indices, w, h) {
  if (w !== P.PANEL.WIDTH || h !== P.PANEL.HEIGHT) {
    throw new Error(`尺寸必须是 ${P.PANEL.WIDTH}×${P.PANEL.HEIGHT}`);
  }
  const bytesPerLine = w / 4;
  const out = new Uint8Array(bytesPerLine * h);
  for (let y = 0; y < h; y++) {
    const row = y * bytesPerLine;
    for (let x = 0; x < w; x += 4) {
      const i = y * w + x;
      out[row + (x >> 2)] =
        (indices[i] << 6) |
        (indices[i + 1] << 4) |
        (indices[i + 2] << 2) |
        indices[i + 3];
    }
  }
  return out;
}

/**
 * 把 RGBA 画面旋转指定角度（顺时针），用于匹配设备软件旋转。
 * 只在 90/270 时交换宽高，调用方需自行处理画布尺寸。
 */
function rotateRGBA(rgba, w, h, degrees) {
  const deg = ((degrees % 360) + 360) % 360;
  if (deg === 0) return { data: rgba, width: w, height: h };
  const outW = deg === 180 ? w : h;
  const outH = deg === 180 ? h : w;
  const out = new Uint8ClampedArray(outW * outH * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx;
      let ny;
      if (deg === 90) { nx = h - 1 - y; ny = x; }
      else if (deg === 180) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      const s = (y * w + x) * 4;
      const d = (ny * outW + nx) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return { data: out, width: outW, height: outH };
}

/**
 * 把任意尺寸图像用 cover 方式铺满目标尺寸（不拉伸变形），返回绘制参数。
 * canvas 侧用 drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh)。
 */
function coverCrop(srcW, srcH, dstW, dstH) {
  const srcRatio = srcW / srcH;
  const dstRatio = dstW / dstH;
  if (srcRatio > dstRatio) {
    const sw = srcH * dstRatio;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  const sh = srcW / dstRatio;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

/**
 * 调试用：把帧字节还原成 RGBA，验证打包/解包是否对称。
 */
function unpackFrameToRGBA(frame, w, h) {
  const bytesPerLine = w / 4;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const byte = frame[y * bytesPerLine + (x >> 2)];
      const code = (byte >> (6 - 2 * (x & 3))) & 0x03;
      const c = PALETTE_BY_CODE[code];
      const i = (y * w + x) * 4;
      out[i] = c.r; out[i + 1] = c.g; out[i + 2] = c.b; out[i + 3] = 255;
    }
  }
  return out;
}

module.exports = {
  PALETTE, PALETTE_BY_CODE, quantize, packFrame, rotateRGBA, coverCrop, unpackFrameToRGBA,
};
