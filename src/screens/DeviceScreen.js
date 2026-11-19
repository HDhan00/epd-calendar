import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import P from '../protocol';
import { ensureBlePermissions, openAppSettings, isAndroid } from '../permissions';
import { s, theme } from '../theme';

export default function DeviceScreen({ ctx }) {
  const { client, connected, info, log, logs, refreshInfo, alert } = ctx;
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(false);   // 同步互斥，state 更新是异步的挡不住连点
  const [connecting, setConnecting] = useState(false);
  const [devices, setDevices] = useState([]);
  const [scanMode, setScanMode] = useState('filtered'); // 'filtered' | 'all'
  const [trace, setTrace] = useState([]);
  const [showTrace, setShowTrace] = useState(false);

  useEffect(() => {
    if (connected && !info) refreshInfo();
  }, [connected]);

  // 切走页面就停扫描：否则会空跑 10~12 秒，还可能在下次进入时撞上残留会话
  useEffect(() => () => {
    scanningRef.current = false;
    try { client.stopScan(); } catch (e) { /* ignore */ }
  }, [client]);

  // trace 是 ble 实例上的可变数组，定期快照一次让界面能刷新
  useEffect(() => {
    const t = setInterval(() => setTrace((client.trace || []).slice(0, 8)), 1000);
    return () => clearInterval(t);
  }, [client]);

  // all=false 按 Service UUID 过滤（正常使用）；all=true 列出附近全部 BLE 设备（排查用）
  const runScan = useCallback(async (allMode) => {
    if (scanningRef.current) return;
    scanningRef.current = true;

    // Android 12+ 必须先拿到「附近的设备」运行时权限，否则系统直接拒绝扫描
    if (isAndroid()) {
      const perm = await ensureBlePermissions();
      if (!perm.granted) {
        log(`缺少蓝牙权限：${(perm.denied || []).join(', ')}`);
        if (perm.neverAskAgain) {
          Alert.alert(
            '需要蓝牙权限',
            '系统已拒绝且不再询问。请到「设置 → 应用 → 墨水屏日历 → 权限 → 附近的设备」手动允许。',
            [
              { text: '取消', style: 'cancel' },
              { text: '去设置', onPress: openAppSettings },
            ],
          );
        } else {
          Alert.alert('需要蓝牙权限', '扫描设备需要「附近的设备」权限，请允许后重试。');
        }
        scanningRef.current = false;
        return;
      }
    }

    setScanMode(allMode ? 'all' : 'filtered');
    setScanning(true);
    setDevices([]);
    try {
      const list = await client.scan(setDevices, allMode ? 12000 : 10000, { all: allMode });
      if (!list.length) {
        log(allMode ? '附近没有扫描到任何 BLE 设备' : '没扫到设备，确认设备已上电。可长按按钮扫描全部设备排查');
      } else if (!allMode && !list.some((d) => d.isEpd)) {
        log('扫到了设备但没有 EPD-Calendar，试试长按扫描全部设备');
      }
    } catch (e) {
      alert('扫描失败', e.message);
      log(`扫描失败：${e.message}`);
    } finally {
      scanningRef.current = false;
      setScanning(false);
    }
  }, [client, log, alert]);

  const onScan = useCallback(() => runScan(false), [runScan]);
  const onScanAll = useCallback(() => runScan(true), [runScan]);

  const onConnect = useCallback(async (id) => {
    if (connecting) return;
    setConnecting(true);
    try {
      await client.connect(id);
      log(`已连接，MTU=${client.mtu}`);
      await refreshInfo();
    } catch (e) {
      log(`连接失败：${e.message}`);
      alert('连接失败', e.message);
    } finally {
      setConnecting(false);
    }
  }, [connecting, client, log, refreshInfo, alert]);

  const onRefresh = async () => {
    try {
      await client.refresh();
      log('已下发强制刷新');
      alert('已受理', '屏幕大约 15 秒刷完，期间设备可能不响应。');
    } catch (e) {
      alert('刷新失败', e.message);
    }
  };

  const onNext = async () => {
    try {
      const slot = await client.nextPhoto();
      log(`切换到照片槽 ${slot}`);
      refreshInfo();
    } catch (e) {
      alert('切换失败', e.message);
    }
  };

  const infoRows = info ? buildRows(info) : [];

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <View style={s.card}>
        <Text style={s.cardTitle}>连接</Text>

        {!connected && (
          <>
            <TouchableOpacity
              style={s.btn}
              onPress={onScan}
              onLongPress={onScanAll}
              delayLongPress={500}
              disabled={scanning}
            >
              <Text style={s.btnText}>
                {scanning ? (scanMode === 'all' ? '扫描全部设备中…' : '扫描中…') : '扫描设备'}
              </Text>
            </TouchableOpacity>
            <Text style={s.hint}>
              {scanMode === 'all'
                ? '排查模式：列出附近全部 BLE 设备（不过滤）'
                : '长按此按钮 → 列出附近全部 BLE 设备，用于排查扫不到的问题'}
            </Text>

            {scanning && <ActivityIndicator style={{ marginTop: 12 }} />}

            {devices.map((d) => (
              <TouchableOpacity
                key={d.id}
                style={[s.row, s.rowLast]}
                onPress={() => onConnect(d.id)}
                disabled={connecting}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.label}>
                    {d.name} {d.isEpd ? '✅' : ''}
                  </Text>
                  <Text style={[s.hint, { marginTop: 2 }]}>
                    {d.rssi} dBm · {d.services.length} 个广播服务 · 点击连接 ›
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </>
        )}

        {connected && (
          <>
            <Row label="MTU" value={`${client.mtu} 字节`} />
            <Row label="单片数据" value={`${client.getChunkSize()} 字节`} last />
            <TouchableOpacity
              style={[s.btn, s.btnGhost]}
              onPress={() => client.disconnect().catch(() => {})}
            >
              <Text style={[s.btnText, s.btnTextGhost]}>断开连接</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {connected && (
        <View style={s.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={s.cardTitle}>设备状态</Text>
            <TouchableOpacity onPress={refreshInfo}>
              <Text style={s.hint}>刷新 ›</Text>
            </TouchableOpacity>
          </View>
          {infoRows.map((r, i) => (
            <Row key={r.label} label={r.label} value={r.value} ok={r.ok} last={i === infoRows.length - 1} />
          ))}
        </View>
      )}

      {connected && (
        <View style={s.card}>
          <Text style={s.cardTitle}>快捷操作</Text>
          <TouchableOpacity style={s.btn} onPress={onRefresh}>
            <Text style={s.btnText}>强制刷新屏幕</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={onNext}>
            <Text style={[s.btnText, s.btnTextGhost]}>下一张照片</Text>
          </TouchableOpacity>
          <Text style={s.hint}>四色全刷约 10–15 秒，期间命令会排队。</Text>
        </View>
      )}

      {connected && (
        <View style={s.card}>
          <Text style={s.cardTitle}>设备回包（诊断）</Text>
          <Text style={s.hint}>点任意一行展开：发送了什么、设备回了什么、状态码什么意思</Text>
          {trace.length === 0 && (
            <Text style={s.hint}>还没有命令记录，先点上面任意按钮试一次</Text>
          )}
          {trace.map((t, i) => (
            <TouchableOpacity
              key={`${t.ts}-${i}`}
              onPress={() => setShowTrace(showTrace === t.ts ? null : t.ts)}
            >
              <View style={[s.row, i === trace.length - 1 && s.rowLast]}>
                <Text style={s.label}>{t.name} #{t.seq}</Text>
                <Text style={[s.value, t.code === 0 ? s.valueOn : s.valueOff]}>
                  {t.code === 0 ? '成功' : (t.code === -1 ? '无响应' : `状态 ${t.code}`)} · {t.ms} ms
                </Text>
              </View>
              {showTrace === t.ts && (
                <View style={{ paddingBottom: 10 }}>
                  <Text style={s.hint}>发送: {t.tx || '(空)'}</Text>
                  <Text style={s.hint}>回包: {t.rx || '(无)'}</Text>
                  {!!t.hint && <Text style={[s.hint, { color: '#b04a3a' }]}>说明: {t.hint}</Text>}
                </View>
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={s.card}>
        <Text style={s.cardTitle}>日志</Text>
        <ScrollView style={s.log} nestedScrollEnabled>
          <Text style={{ fontFamily: 'monospace', fontSize: 11, color: theme.muted }}>
            {logs.length ? logs.join('\n') : '暂无日志'}
          </Text>
        </ScrollView>
      </View>
    </ScrollView>
  );
}

function Row({ label, value, ok, last }) {
  return (
    <View style={[s.row, last && s.rowLast]}>
      <Text style={s.label}>{label}</Text>
      <Text style={[s.value, ok === true && s.valueOn, ok === false && s.valueOff]}>{value}</Text>
    </View>
  );
}

function buildRows(info) {
  const now = Math.floor(Date.now() / 1000);
  const age = info.weatherUpdatedUnix ? now - info.weatherUpdatedUnix : -1;
  const rows = [
    { label: '显示模式', value: P.MODE_TEXT[info.mode] || '未知' },
    { label: '屏幕方向', value: P.ROTATION_TEXT[info.rotation] || '未知' },
    { label: 'Wi-Fi', value: info.wifiConnected ? '已连接' : (info.wifiSaved ? '已保存未连上' : '未配置'), ok: !!info.wifiConnected },
    { label: 'NTP 校时', value: info.ntpSynced ? '已同步' : '未同步', ok: !!info.ntpSynced },
    { label: '天气', value: info.weatherValid ? `${(info.temperatureC10 / 10).toFixed(1)} °C` : '无数据', ok: !!info.weatherValid },
    { label: '天气更新', value: age >= 0 ? `${Math.floor(age / 60)} 分钟前` : '—' },
    { label: 'Wi-Fi 功率', value: `${(info.wifiTxQdbm / 4).toFixed(2)} dBm` },
    { label: 'BLE 功率', value: `${info.bleTxDbm} dBm` },
    { label: '自动刷新', value: `${Math.floor(info.autoRefreshSec / 60)} 分钟` },
    { label: '时区', value: info.timezone || '—' },
    { label: '位置', value: `${(info.latitudeE7 / 1e7).toFixed(4)}, ${(info.longitudeE7 / 1e7).toFixed(4)}` },
    { label: '今日计划', value: info.todayPlan || '无' },
    { label: '照片槽', value: `#${info.photoSlot}` },
  ];
  if (info.uploadActive) {
    rows.push({
      label: '上传中',
      value: `槽 ${info.uploadSlot} ${info.uploadNextOffset}/${info.uploadTotalLen}`,
      ok: true,
    });
  }
  return rows;
}
