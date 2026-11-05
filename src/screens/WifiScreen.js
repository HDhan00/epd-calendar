import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert,
} from 'react-native';
import { s } from '../theme';

export default function WifiScreen({ ctx }) {
  const { client, connected, refreshInfo, log, alert } = ctx;

  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [status, setStatus] = useState(null); // {wifiConnected, ntpSynced, wifiSaved}
  const [polling, setPolling] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (connected) pollOnce();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [connected]);

  const pollOnce = useCallback(async () => {
    if (!client.connected) return false;
    try {
      const info = await client.getInfo();
      setStatus(info);
      return info.wifiConnected;
    } catch (e) {
      return false;
    }
  }, [client]);

  const startPolling = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setPolling(true);
    let attempts = 0;
    timerRef.current = setInterval(async () => {
      attempts++;
      const ok = await pollOnce();
      if (ok || attempts >= 20) {
        clearInterval(timerRef.current);
        timerRef.current = null;
        setPolling(false);
      }
    }, 2000);
  }, [pollOnce]);

  const onSave = async () => {
    if (!client.connected) {
      alert('未连接', '请先连接设备');
      return;
    }
    if (!ssid.trim()) {
      alert('缺少 SSID', '请输入 Wi-Fi 名称');
      return;
    }
    try {
      await client.setWifi(ssid.trim(), password);
      log(`Wi-Fi 凭据已写入：${ssid}`);
      startPolling();
      refreshInfo();
    } catch (e) {
      alert('配网失败', e.message);
    }
  };

  const onClear = () => {
    Alert.alert('清除 Wi-Fi 凭据', '设备会断开 Wi-Fi，需要重新配网才能联网校时和更新天气。', [
      { text: '取消', style: 'cancel' },
      {
        text: '确认清除',
        style: 'destructive',
        onPress: async () => {
          try {
            await client.setWifi('', '');
            setSsid('');
            setPassword('');
            log('已清除 Wi-Fi 凭据');
            pollOnce();
          } catch (e) {
            alert('清除失败', e.message);
          }
        },
      },
    ]);
  };

  const text = !status
    ? '未读取'
    : status.wifiConnected
      ? `已联网${status.ntpSynced ? '，时间已同步' : '，正在校时'}`
      : (status.wifiSaved ? '已保存凭据，尚未连上路由器' : '未配置 Wi-Fi');

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <View style={s.card}>
        <Text style={s.cardTitle}>网络状态</Text>
        <View style={[s.row, s.rowLast]}>
          <Text style={s.label}>Wi-Fi</Text>
          <Text style={[s.value, status && (status.wifiConnected ? s.valueOn : s.valueOff)]}>
            {status ? (status.wifiConnected ? '已连接' : '未连接') : '—'}
          </Text>
        </View>
        <Text style={s.hint}>{polling ? '正在等待联网… ' : ''}{text}</Text>
        <TouchableOpacity
          style={[s.btn, s.btnGhost, !connected && s.btnDisabled]}
          disabled={!connected}
          onPress={pollOnce}
        >
          <Text style={[s.btnText, s.btnTextGhost]}>刷新状态</Text>
        </TouchableOpacity>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Wi-Fi 配网</Text>
        <Text style={s.label}>名称</Text>
        <TextInput
          style={s.input}
          value={ssid}
          onChangeText={setSsid}
          placeholder="路由器 SSID"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={32}
        />
        <View style={{ height: 10 }} />
        <Text style={s.label}>密码</Text>
        <TextInput
          style={s.input}
          value={password}
          onChangeText={setPassword}
          placeholder="留空表示开放网络"
          secureTextEntry={!showPass}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={64}
        />
        <TouchableOpacity onPress={() => setShowPass(!showPass)}>
          <Text style={s.hint}>{showPass ? '隐藏密码' : '显示密码'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.btn, !connected && s.btnDisabled]}
          disabled={!connected}
          onPress={onSave}
        >
          <Text style={s.btnText}>保存并连接</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.btn, s.btnDanger, !connected && s.btnDisabled]}
          disabled={!connected}
          onPress={onClear}
        >
          <Text style={s.btnText}>清除凭据</Text>
        </TouchableOpacity>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>安全说明</Text>
        <Text style={s.hint}>
          设备 BLE 链路是开放的（协议 v1 无配对/加密），Wi-Fi 密码明文经过空口。
          只在可信的近距离环境配网。密码写入后固件不会回传。
        </Text>
      </View>
    </ScrollView>
  );
}
