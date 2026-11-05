/**
 * 图片 → 设备帧（105984 字节）流水线
 *
 * RN 里没有 canvas.getImageData，所以走这条路：
 *   ImageManipulator 旋转/缩放/裁剪  →  JPEG + base64（一次拿到，不落盘再读）
 *   base64 → 字节 → jpeg-js 解码成 RGBA
 *   src/image.js 量化 + 2bpp 打包    →  Uint8Array(105984)
 *   src/png.js 生成预览 data URI
 *
 * 好处：只用 expo 官方模块 + 一个纯 JS 解码器，不需要 Skia/GL。
 */

import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';
import jpeg from 'jpeg-js';

import P from './protocol';
import IMG from './image';
import { rgbaToDataUri, downsampleRGBA } from './png';

const W = P.PANEL.WIDTH;
const H = P.PANEL.HEIGHT;

export function getImageSize(uri) {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

function base64ToBytes(b64) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
  lookup['='.charCodeAt(0)] = 0;

  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4) - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = lookup[clean.charCodeAt(i)];
    const c1 = lookup[clean.charCodeAt(i + 1)];
    const c2 = lookup[clean.charCodeAt(i + 2)];
    const c3 = lookup[clean.charCodeAt(i + 3)];
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (o < out.length) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (o < out.length) out[o++] = ((c2 & 3) << 6) | c3;
  }
  return out;
}

/**
 * @param {string} uri 相册选中的图片
 * @param {number} rotateDeg 0/90/180/270，先旋转再铺满裁剪
 * @returns {Promise<{frame:Uint8Array, previewUri:string, stats:object, ms:number}>}
 */
export async function buildFrame(uri, rotateDeg = 0) {
  const t0 = Date.now();

  // 1) 先旋转（旋转会交换宽高），再按目标比例 cover 裁剪
  let work = uri;
  let size = await getImageSize(uri);
  const deg = ((rotateDeg % 360) + 360) % 360;

  if (deg !== 0) {
    const rotated = await ImageManipulator.manipulateAsync(uri, [{ rotate: deg }], {
      compress: 1,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    work = rotated.uri;
    size = { width: rotated.width, height: rotated.height };
  }

  const scale = Math.max(W / size.width, H / size.height);
  const scaledW = Math.round(size.width * scale);
  const scaledH = Math.round(size.height * scale);

  const result = await ImageManipulator.manipulateAsync(
    work,
    [
      { resize: { width: scaledW, height: scaledH } },
      {
        crop: {
          originX: Math.max(0, Math.round((scaledW - W) / 2)),
          originY: Math.max(0, Math.round((scaledH - H) / 2)),
          width: W,
          height: H,
        },
      },
    ],
    // base64: true 让 manipulateAsync 直接把像素数据一并返回，
    // 省掉「写盘 → 再读回来」这一步，也不依赖 expo-file-system
    { compress: 1, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );

  // 2) 解码成 RGBA
  if (!result.base64) throw new Error('ImageManipulator 未返回 base64 数据');
  const decoded = jpeg.decode(base64ToBytes(result.base64), {
    useTArray: true,
    maxMemoryUsageInMB: 256,
  });
  if (decoded.width !== W || decoded.height !== H) {
    throw new Error(`裁剪后尺寸异常：${decoded.width}×${decoded.height}`);
  }

  // 3) 量化 + 打包
  const { indices, preview, stats } = IMG.quantize(decoded.data, W, H);
  const frame = IMG.packFrame(indices, W, H);

  // 4) 预览（半分辨率 PNG，省内存）
  const small = downsampleRGBA(preview, W, H, 2);
  const previewUri = rgbaToDataUri(small.data, small.width, small.height);

  return {
    frame,
    previewUri,
    stats,
    ms: Date.now() - t0,
  };
}

export function statsPercent(stats) {
  const total = W * H;
  return {
    white: ((stats[P.PANEL.WHITE] / total) * 100).toFixed(1),
    black: ((stats[P.PANEL.BLACK] / total) * 100).toFixed(1),
    yellow: ((stats[P.PANEL.YELLOW] / total) * 100).toFixed(1),
    red: ((stats[P.PANEL.RED] / total) * 100).toFixed(1),
  };
}
