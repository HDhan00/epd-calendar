/**
 * 蓝牙运行时权限
 *
 * Android 12（API 31）起，BLUETOOTH_SCAN / BLUETOOTH_CONNECT 从"安装即授予"
 * 变成了危险的运行时权限：**写进 manifest 只是声明，用户没点过同意照样扫不到**。
 * 报错原文就是 "Device is not authorized to use BluetoothLE"。
 *
 * Android 11 及以下仍然用 ACCESS_FINE_LOCATION（扫描 BLE 需要定位权限）。
 */

import { Platform, PermissionsAndroid, Linking } from 'react-native';

const ANDROID_12 = 31;

export function isAndroid() {
  return Platform.OS === 'android';
}

export function androidApiLevel() {
  const v = Platform.Version;
  return typeof v === 'number' ? v : parseInt(v, 10);
}

/**
 * 申请扫描/连接所需的权限。
 * @returns {Promise<{granted: boolean, neverAskAgain?: boolean, denied?: string[]}>}
 */
export async function ensureBlePermissions() {
  if (!isAndroid()) return { granted: true };

  const wanted = androidApiLevel() >= ANDROID_12
    ? [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  // 已经授予的就不重复弹窗（Android 不会二次弹，但会白等一次）
  const already = [];
  for (const p of wanted) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await PermissionsAndroid.check(p);
    if (!ok) already.push(p);
  }
  if (!already.length) return { granted: true };

  const results = await PermissionsAndroid.requestMultiple(already);
  const denied = [];
  let neverAskAgain = false;

  for (const p of already) {
    const r = results[p];
    if (r === PermissionsAndroid.RESULTS.GRANTED) continue;
    denied.push(p);
    if (r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) neverAskAgain = true;
  }

  if (!denied.length) return { granted: true };
  return { granted: false, neverAskAgain, denied };
}

/** 打开本应用的系统设置页，让用户手动开权限 */
export function openAppSettings() {
  Linking.openSettings().catch(() => {});
}
