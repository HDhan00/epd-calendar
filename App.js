import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SafeAreaView, View, Text, TouchableOpacity, ScrollView, StatusBar,
  StyleSheet, Platform, Alert,
} from 'react-native';

import EpdBle from './src/ble';
import { theme } from './src/theme';
import DeviceScreen from './src/screens/DeviceScreen';
import ConfigScreen from './src/screens/ConfigScreen';
import WifiScreen from './src/screens/WifiScreen';
import PhotoScreen from './src/screens/PhotoScreen';

const TABS = [
  { key: 'device', label: '设备' },
  { key: 'config', label: '设置' },
  { key: 'wifi', label: '配网' },
  { key: 'photo', label: '相册' },
];

export default function App() {
  const clientRef = useRef(null);
  if (!clientRef.current) clientRef.current = new EpdBle();

  const [tab, setTab] = useState('device');
  const [connected, setConnected] = useState(false);
  const [info, setInfo] = useState(null);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);

  const log = useCallback((msg) => {
    const t = new Date().toTimeString().slice(0, 8);
    setLogs((prev) => [`[${t}] ${msg}`, ...prev].slice(0, 60));
  }, []);

  useEffect(() => {
    const c = clientRef.current;
    c.onStateChange = (isConnected) => {
      setConnected(isConnected);
      if (!isConnected) setInfo(null);
      log(isConnected ? '设备已连接' : '设备已断开');
    };
    return () => {
      c.destroy();
    };
  }, [log]);

  const refreshInfo = useCallback(async () => {
    const c = clientRef.current;
    if (!c.connected) return null;
    try {
      const i = await c.getInfo();
      setInfo(i);
      return i;
    } catch (e) {
      log(`GET_INFO 失败：${e.message}`);
      return null;
    }
  }, [log]);

  const ctx = useMemo(() => ({
    client: clientRef.current,
    connected,
    info,
    setInfo,
    log,
    logs,
    refreshInfo,
    busy,
    setBusy,
    alert: (title, msg) => Alert.alert(title, msg || '', [{ text: '知道了' }]),
  }), [connected, info, log, logs, refreshInfo, busy]);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={theme.bg} />

      <View style={styles.header}>
        <Text style={styles.title}>墨水屏日历</Text>
        <View style={[styles.dot, { backgroundColor: connected ? theme.ok : theme.err }]} />
        <Text style={styles.status}>{connected ? '已连接' : '未连接'}</Text>
      </View>

      <View style={styles.body}>
        {tab === 'device' && <DeviceScreen ctx={ctx} />}
        {tab === 'config' && <ConfigScreen ctx={ctx} />}
        {tab === 'wifi' && <WifiScreen ctx={ctx} />}
        {tab === 'photo' && <PhotoScreen ctx={ctx} />}
      </View>

      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={styles.tab}
            onPress={() => setTab(t.key)}
            accessibilityRole="button"
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
            {tab === t.key && <View style={styles.tabUnderline} />}
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line,
  },
  title: { fontSize: 18, fontWeight: '700', color: theme.ink, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  status: { fontSize: 13, color: theme.muted },
  body: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.line,
    backgroundColor: theme.card,
    paddingBottom: Platform.OS === 'ios' ? 18 : 6,
  },
  tab: { flex: 1, alignItems: 'center', paddingTop: 10, paddingBottom: 8 },
  tabText: { fontSize: 13, color: theme.muted },
  tabTextActive: { color: theme.ink, fontWeight: '700' },
  tabUnderline: {
    marginTop: 5,
    width: 18,
    height: 2,
    borderRadius: 1,
    backgroundColor: theme.ink,
  },
});
