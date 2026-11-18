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
  { code: P.PANEL.BLACK, name: '黑', r: 18, g: 18, b: 20 },
  // 四色墨水屏的颜料比 LCD 更"实"，黄很亮、红很正。
  // 之前用的是偏暗的估算值，导致浅色像素全被判成白色，画面发灰。
  { code: P.PANEL.YELLOW, name: '黄', r: 255, g: 208, b: 0 },
  { code: P.PANEL.RED, name: '红', r: 205, g: 22, b: 32 },
];

// sRGB → 线性光
function toLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function fromLinear(v) {
  const x = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, x * 255));
}

// sRGB → OKLab（感知均匀空间，色差更接近人眼判断）
function linearToOklab(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

const PALETTE_LAB = PALETTE.map((c) =>
  linearToOklab(toLinear(c.r), toLinear(c.g), toLinear(c.b)),
);

const PALETTE_BY_CODE = {};
PALETTE.forEach((c) => { PALETTE_BY_CODE[c.code] = c; });

// 面板色在 PALETTE 里的下标
const IDX_WHITE = 0;
const IDX_BLACK = 1;
const IDX_YELLOW = 2;
const IDX_RED = 3;

/**
 * 在 OKLab 里选最近的面板色，带"能不能用彩色"的门控。
 *
 * 为什么要门控：OKLab 只看距离时，中灰(128,128,128)离"红"最近
 * （红的亮度接近中灰），结果整张灰度图会被判成红色。
 * 四色屏没有蓝/绿，蓝色和绿色也只能靠黑白网点近似。
 */
function nearestIndexLab(lab) {
  const L = lab[0];
  const a = lab[1];
  const b = lab[2];
  const chroma = Math.sqrt(a * a + b * b);

  // ① 近中性（灰、白、黑）→ 只在黑白之间抖动
  // ② 偏蓝 / 偏绿 → 调色板里没有对应颜料，也用黑白抖动表现亮度
  const neutral = chroma < 0.035 || b < -0.015 || a < -0.02;
  const allowColor = !neutral;

  let best = IDX_WHITE;
  let bestDist = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const isColor = (i === IDX_YELLOW || i === IDX_RED);
    if (isColor && !allowColor) continue;
    const c = PALETTE_LAB[i];
    const dl = L - c[0];
    const da = a - c[1];
    const db2 = b - c[2];
    // 亮度权重 1.0，色度权重 2.5：让"像什么颜色"比"多亮"更重要
    const d = dl * dl + 2.5 * (da * da + db2 * db2);
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
  // 饱和度增益：四色屏只有 4 个纯色，偏淡的图片必须先把颜色"推"向纯色，
  // 否则浅粉/浅黄会被判成白色，整张图发灰。
  const sat = opts.saturation === undefined ? 1.35 : opts.saturation;

  // 线性光空间的浮点缓冲，误差累积才符合物理叠加
  const buf = new Float32Array(w * h * 3);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    let r = toLinear(rgba[p]);
    let g = toLinear(rgba[p + 1]);
    let b = toLinear(rgba[p + 2]);
    // 提饱和：围绕亮度做线性拉伸
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = lum + (r - lum) * sat;
    g = lum + (g - lum) * sat;
    b = lum + (b - lum) * sat;
    buf[i * 3] = Math.min(1, Math.max(0, r));
    buf[i * 3 + 1] = Math.min(1, Math.max(0, g));
    buf[i * 3 + 2] = Math.min(1, Math.max(0, b));
  }

  // 预先算好面板色的线性光值，扩散误差时用
  const PAL_LIN = PALETTE.map((c) => [toLinear(c.r), toLinear(c.g), toLinear(c.b)]);

  const indices = new Uint8Array(w * h);
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };

  const spread = (x, y, er, eg, eb, factor) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 3;
    buf[i] = Math.min(1, Math.max(0, buf[i] + er * factor * strength));
    buf[i + 1] = Math.min(1, Math.max(0, buf[i + 1] + eg * factor * strength));
    buf[i + 2] = Math.min(1, Math.max(0, buf[i + 2] + eb * factor * strength));
  };

  for (let y = 0; y < h; y++) {
    const leftToRight = !serpentine || (y % 2 === 0);
    for (let k = 0; k < w; k++) {
      const x = leftToRight ? k : w - 1 - k;
      const idx = y * w + x;
      const r = buf[idx * 3];
      const g = buf[idx * 3 + 1];
      const b = buf[idx * 3 + 2];

      const pi = nearestIndexLab(linearToOklab(r, g, b));
      const c = PALETTE[pi];
      indices[idx] = c.code;
      counts[c.code]++;

      const lin = PAL_LIN[pi];
      const er = r - lin[0];
      const eg = g - lin[1];
      const eb = b - lin[2];
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

module.exports.__debug = { PALETTE, PALETTE_LAB, toLinear, fromLinear, linearToOklab };

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
