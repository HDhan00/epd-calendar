import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Image, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import P from '../protocol';
import { buildFrame, statsPercent } from '../pixel';
import { s } from '../theme';

const ROTATIONS = [0, 90, 180, 270];

export default function PhotoScreen({ ctx }) {
  const { client, connected, info, log, alert } = ctx;

  const [uri, setUri] = useState(null);
  const [rotate, setRotate] = useState(0);
  const [slot, setSlot] = useState(0);
  const [building, setBuilding] = useState(false);
  const [preview, setPreview] = useState(null);
  const [stats, setStats] = useState(null);
  const [frame, setFrame] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speedText, setSpeedText] = useState('');
  const abortRef = useRef(false);

  const deviceDeg = info ? info.rotation * 90 : null;

  const process = useCallback(async (assetUri, deg) => {
    setBuilding(true);
    setPreview(null);
    try {
      const result = await buildFrame(assetUri, deg);
      setFrame(result.frame);
      setPreview(result.previewUri);
      setStats(statsPercent(result.stats));
      log(`量化完成 ${result.ms} ms，${result.frame.length} 字节`);
    } catch (e) {
      log(`处理失败：${e.message}`);
      alert('图片处理失败', e.message);
    } finally {
      setBuilding(false);
    }
  }, [log, alert]);

  const onPick = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      alert('没有相册权限', '请在系统设置里允许本应用访问照片。');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
      exif: false,
    });
    if (res.canceled || !res.assets || !res.assets.length) return;
    const asset = res.assets[0];
    setUri(asset.uri);
    await process(asset.uri, rotate);
  };

  const onRotate = async (deg) => {
    setRotate(deg);
    if (uri) await process(uri, deg);
  };

  const onUpload = async () => {
    if (!client.connected) {
      alert('未连接', '请先连接设备');
      return;
    }
    if (!frame) {
      alert('还没有画面', '请先选择一张图片');
      return;
    }
    abortRef.current = false;
    setUploading(true);
    setProgress(0);
    const t0 = Date.now();

    try {
      const result = await client.uploadPhoto(frame, slot, {
        onProgress: (done, total) => {
          const pct = Math.floor((done / total) * 100);
          const secs = (Date.now() - t0) / 1000;
          const kbps = secs > 0 ? done / 1024 / secs : 0;
          const remain = kbps > 0 ? (total - done) / 1024 / kbps : 0;
          setProgress(pct);
          setSpeedText(done >= total
            ? '提交中…'
            : `${kbps.toFixed(1)} KB/s · 剩余约 ${Math.ceil(remain)} 秒`);
        },
        shouldAbort: () => abortRef.current,
      });
      log(`照片已提交：槽 ${result.slot}，CRC32=${result.crc32.toString(16)}`);
      alert('上传成功', `已写入槽 ${result.slot}，设备开始刷新（约 15 秒）。`);
    } catch (e) {
      log(`上传失败：${e.message}`);
      alert('上传失败', e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      {!connected && (
        <View style={s.card}>
          <Text style={s.cardTitle}>未连接</Text>
          <Text style={s.hint}>请先到「设备」页连接设备。</Text>
        </View>
      )}

      <View style={s.card}>
        <Text style={s.cardTitle}>画面预览</Text>
        {preview ? (
          <Image source={{ uri: preview }} style={s.preview} resizeMode="contain" />
        ) : (
          <View style={[s.preview, { alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={s.hint}>{building ? '正在量化…' : '选择图片后这里显示四色预览'}</Text>
          </View>
        )}
        {building && <ActivityIndicator style={{ marginTop: 10 }} />}

        <TouchableOpacity style={s.btn} onPress={onPick} disabled={building}>
          <Text style={s.btnText}>{uri ? '重新选择图片' : '选择图片'}</Text>
        </TouchableOpacity>
      </View>

      {frame && (
        <View style={s.card}>
          <Text style={s.cardTitle}>上传参数</Text>

          <Text style={s.label}>目标槽位</Text>
          <View style={s.segRow}>
            {[0, 1, 2, 3].map((i) => (
              <TouchableOpacity
                key={i}
                style={[s.seg, slot === i && s.segActive]}
                onPress={() => setSlot(i)}
              >
                <Text style={[s.segText, slot === i && s.segTextActive]}>槽 {i}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={s.label}>画面方向</Text>
          <View style={s.segRow}>
            {ROTATIONS.map((deg) => (
              <TouchableOpacity
                key={deg}
                style={[s.seg, rotate === deg && s.segActive]}
                onPress={() => onRotate(deg)}
              >
                <Text style={[s.segText, rotate === deg && s.segTextActive]}>{deg}°</Text>
              </TouchableOpacity>
            ))}
          </View>
          {deviceDeg !== null && (
            <Text style={s.hint}>设备当前软件旋转 {deviceDeg}°，建议这里选一样的角度。</Text>
          )}

          {stats && (
            <Text style={s.hint}>
              用色：白 {stats.white}% · 黑 {stats.black}% · 黄 {stats.yellow}% · 红 {stats.red}%
            </Text>
          )}
          <Text style={s.hint}>
            帧 {frame.length} 字节 · 单片 {client.getChunkSize()} 字节 · 共 {Math.ceil(frame.length / client.getChunkSize())} 帧
          </Text>
        </View>
      )}

      {(uploading || progress > 0) && (
        <View style={s.card}>
          <Text style={s.cardTitle}>上传进度 {progress}%</Text>
          <View style={s.progressTrack}>
            <View style={[s.progressBar, { width: `${progress}%` }]} />
          </View>
          <Text style={s.hint}>{speedText}</Text>
          {uploading && (
            <TouchableOpacity
              style={[s.btn, s.btnGhost]}
              onPress={() => { abortRef.current = true; }}
            >
              <Text style={[s.btnText, s.btnTextGhost]}>取消上传</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <View style={s.card}>
        <TouchableOpacity
          style={[s.btn, (!connected || !frame || uploading) && s.btnDisabled]}
          disabled={!connected || !frame || uploading}
          onPress={onUpload}
        >
          <Text style={s.btnText}>{uploading ? '上传中…' : '上传到设备'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.btn, s.btnGhost, !connected && s.btnDisabled]}
          disabled={!connected}
          onPress={() => client.photoAbort().then(() => alert('已取消', '设备端未完成的上传已丢弃')).catch((e) => alert('取消失败', e.message))}
        >
          <Text style={[s.btnText, s.btnTextGhost]}>取消设备端的未完成上传</Text>
        </TouchableOpacity>
        <Text style={s.hint}>
          断线重连后再次上传，会用同一 photo_id 从设备返回的偏移续传（进度在设备内存，断电即丢）。
        </Text>
      </View>
    </ScrollView>
  );
}
