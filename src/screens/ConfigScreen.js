import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
} from 'react-native';
import P from '../protocol';
import { s } from '../theme';

export default function ConfigScreen({ ctx }) {
  const { client, connected, info, refreshInfo, log, alert } = ctx;

  const [mode, setMode] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [tz, setTz] = useState('Asia/Shanghai');
  const [lat, setLat] = useState('31.2304');
  const [lon, setLon] = useState('121.4737');
  const [plan, setPlan] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!info) return;
    setMode(info.mode);
    setRotation(info.rotation);
    setTz(info.timezone || 'Asia/Shanghai');
    setLat((info.latitudeE7 / 1e7).toFixed(4));
    setLon((info.longitudeE7 / 1e7).toFixed(4));
    setPlan(info.todayPlan || '');
  }, [info]);

  const guard = () => {
    if (!connected) {
      alert('未连接', '请先到「设备」页连接设备');
      return false;
    }
    return true;
  };

  const run = async (fn, okMsg) => {
    if (!guard() || busy) return;
    setBusy(true);
    try {
      await fn();
      log(okMsg);
      alert('完成', okMsg);
      setTimeout(refreshInfo, 1500);
    } catch (e) {
      alert('失败', e.message);
    } finally {
      setBusy(false);
    }
  };

  const planBytes = P.utf8ByteLength(plan);

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      {!connected && (
        <View style={s.card}>
          <Text style={s.cardTitle}>未连接</Text>
          <Text style={s.hint}>请先到「设备」页连接设备。</Text>
        </View>
      )}

      <View style={s.card}>
        <Text style={s.cardTitle}>主页模式</Text>
        <View style={s.segRow}>
          {P.MODE_TEXT.map((t, i) => (
            <TouchableOpacity
              key={t}
              style={[s.seg, mode === i && s.segActive]}
              onPress={() => setMode(i)}
            >
              <Text style={[s.segText, mode === i && s.segTextActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={[s.btn, (!connected || busy) && s.btnDisabled]}
          disabled={!connected || busy}
          onPress={() => run(() => client.setMode(mode), `模式切换为「${P.MODE_TEXT[mode]}」`)}
        >
          <Text style={s.btnText}>应用模式</Text>
        </TouchableOpacity>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>屏幕方向</Text>
        <View style={s.segRow}>
          {P.ROTATION_TEXT.map((t, i) => (
            <TouchableOpacity
              key={t}
              style={[s.seg, rotation === i && s.segActive]}
              onPress={() => setRotation(i)}
            >
              <Text style={[s.segText, rotation === i && s.segTextActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={[s.btn, (!connected || busy) && s.btnDisabled]}
          disabled={!connected || busy}
          onPress={() => run(() => client.setRotation(rotation), `方向设为 ${rotation * 90}°`)}
        >
          <Text style={s.btnText}>应用方向</Text>
        </TouchableOpacity>
        <Text style={s.hint}>上传相片时要和这里的方向匹配，否则画面会歪。</Text>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>时区</Text>
        <TextInput
          style={s.input}
          value={tz}
          onChangeText={setTz}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Asia/Shanghai"
        />
        <View style={s.segRow}>
          {['Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'UTC'].map((t) => (
            <TouchableOpacity key={t} style={s.seg} onPress={() => setTz(t)}>
              <Text style={s.segText}>{t.split('/').pop()}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={[s.btn, (!connected || busy) && s.btnDisabled]}
          disabled={!connected || busy}
          onPress={() => run(() => client.setTimezone(tz.trim()), `时区设为 ${tz}`)}
        >
          <Text style={s.btnText}>保存时区</Text>
        </TouchableOpacity>
        <Text style={s.hint}>只允许字母、数字与 _ + . / -</Text>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>位置（天气）</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>纬度</Text>
            <TextInput style={s.input} value={lat} onChangeText={setLat} keyboardType="numbers-and-punctuation" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>经度</Text>
            <TextInput style={s.input} value={lon} onChangeText={setLon} keyboardType="numbers-and-punctuation" />
          </View>
        </View>
        <TouchableOpacity
          style={[s.btn, (!connected || busy) && s.btnDisabled]}
          disabled={!connected || busy}
          onPress={() => run(
            () => client.setLocation(Number(lat), Number(lon)),
            `位置设为 ${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}，已请求更新天气`,
          )}
        >
          <Text style={s.btnText}>保存位置并更新天气</Text>
        </TouchableOpacity>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>今日计划</Text>
        <TextInput
          style={s.input}
          value={plan}
          onChangeText={setPlan}
          placeholder="留空显示「无」"
          maxLength={40}
        />
        <Text style={[s.hint, planBytes > P.LIMITS.TODAY_PLAN_MAX && { color: '#b04a3a' }]}>
          {planBytes}/{P.LIMITS.TODAY_PLAN_MAX} 字节{planBytes > P.LIMITS.TODAY_PLAN_MAX ? ' · 超出上限' : ''}
        </Text>
        <TouchableOpacity
          style={[s.btn, (!connected || busy || planBytes > P.LIMITS.TODAY_PLAN_MAX) && s.btnDisabled]}
          disabled={!connected || busy || planBytes > P.LIMITS.TODAY_PLAN_MAX}
          onPress={() => run(() => client.setTodayPlan(plan), `今日计划已更新（${planBytes} 字节）`)}
        >
          <Text style={s.btnText}>保存今日计划</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.btn, s.btnGhost, (!connected || busy) && s.btnDisabled]}
          disabled={!connected || busy}
          onPress={() => { setPlan(''); run(() => client.setTodayPlan(''), '已清空今日计划'); }}
        >
          <Text style={[s.btnText, s.btnTextGhost]}>清空</Text>
        </TouchableOpacity>
        <Text style={s.hint}>上限 30 字节（约 10 个汉字）。设备不会按日期自动清空。</Text>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>其他</Text>
        <TouchableOpacity
          style={[s.btn, s.btnGhost, (!connected || busy) && s.btnDisabled]}
          disabled={!connected || busy}
          onPress={() => run(() => client.weatherRefresh(), '已请求刷新天气')}
        >
          <Text style={[s.btnText, s.btnTextGhost]}>立即更新天气</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}
