# 墨水屏日历 · Android App（Expo + EAS 云构建）

配套固件：[panyihang/3.98Inch-ESP32C3-EPD](https://github.com/panyihang/3.98Inch-ESP32C3-EPD)
协议：[docs/ble_protocol.md](https://github.com/panyihang/3.98Inch-ESP32C3-EPD/blob/main/docs/ble_protocol.md)

---

## 先说清楚：Expo Go 不能跑这个 App

| 方式 | 能不能用 | 原因 |
|---|---|---|
| **Expo Go** | ❌ | Expo Go 是预编译的通用客户端，装不了 `react-native-ble-plx` 这种**原生模块**。BLE 必须走原生代码 |
| **development build**（dev client） | ✅ | 用 EAS 云端构建一个带原生模块的调试包 |
| **EAS Build → APK** | ✅ 推荐 | 云端编译出可安装的 APK，本地不需要 Android SDK / Java |

也就是说：**"Expo Go" 和 "云端构建" 是两条路，你要的是后者。**

---

## 一、准备工作（都在电脑上做，不需要装 Android Studio）

```bash
# 1. Node 18+ 已装好即可
node -v

# 2. 装 EAS CLI
npm install -g eas-cli

# 3. 注册/登录 Expo 账号（免费）
eas login
```

免费账号就能构建，排队时间看运气（几分钟到几十分钟）。免费额度有限（每月若干次构建），
超出要升级 EAS 付费计划。

---

## 二、构建 APK（三步）

```bash
cd epd-expo

# 1. 装依赖（版本对不齐的话跑 npx expo install --fix 自动修）
npm install
npx expo install --fix

# 2. 首次会问你 App 的 package name，确认用 com.panyihang.epdcalendar 或改成你自己的
#    （第一次 build 时 EAS 会自动生成 Android 签名 keystore，选择 "Yes, generate"）
eas build -p android --profile preview

# 3. 构建完终端会给一个下载链接，手机打开直接装
```

`eas.json` 里 `preview` 配置了 `"buildType": "apk"`，所以产出的是**可直接安装的 APK**，
不是上架用的 AAB。

### 想边改边调试（热更新 JS）

```bash
eas build -p android --profile development   # 出一个 dev client 安装包
npx expo start --dev-client                  # 之后 JS 改动即时生效
```

---

## 三、装到手机后

1. 打开 App → 允许**附近设备**权限（Android 12+ 必须，否则扫不到）
2. 「设备」页 → 扫描 → 连 `EPD-Calendar`
3. 其余四个页签：设置 / 配网 / 相册

---

## 四、目录结构

```
App.js                      tab 外壳 + 全局状态（连接、info、日志）
src/protocol.js             帧编解码 / CRC16 / CRC32 / 14 条命令   ← 与小程序版完全相同
src/image.js                四色量化（Floyd–Steinberg）+ 2bpp 打包  ← 与小程序版完全相同
src/ble.js                  react-native-ble-plx 传输层（序号匹配、上传状态机）
src/pixel.js                图片 → 768×552 RGBA → 帧，全流程
src/png.js                  纯 JS PNG 编码器（给预览用，零依赖）
src/base64.js               base64 ↔ Uint8Array
src/theme.js                纸张配色 + 通用样式
src/screens/DeviceScreen    扫描/连接/设备状态/刷新/日志
src/screens/ConfigScreen    模式/旋转/时区/位置/今日计划
src/screens/WifiScreen      配网 + 状态轮询
src/screens/PhotoScreen     选图/旋转/量化预览/上传进度
```

**为什么预览要自己写 PNG 编码器**：RN 没有 `canvas.getImageData`，也不方便把 Uint8Array
直接显示成图片。装 Skia 只为了预览太重，所以用「存储型 deflate」写了一百行 PNG 编码，
把量化结果变成 `data:image/png;base64,...` 给 `<Image>`。

---

## 五、图片处理链路

```
相册选图（expo-image-picker）
   ↓ 旋转（可选 0/90/180/270）
ImageManipulator：按 cover 比例缩放 + 居中裁到 768×552
   ↓ JPEG
FileSystem 读 base64 → jpeg-js 解码成 RGBA
   ↓
Floyd–Steinberg 量化到 4 色 → 2bpp 打包 → 105984 字节
   ↓ 分片（MTU-3-10-4 = 230 字节/片）
BLE 上传：PHOTO_BEGIN → PHOTO_DATA×461 → PHOTO_END
```

---

## 六、已知限制

1. **Expo Go 用不了**，必须 EAS Build（见开头）。
2. **iOS 可以构建，但需要 Apple 开发者账号**（$99/年）才能装到真机；安卓 APK 免费。
3. **四色 RGB 是估算值**，改 `src/image.js` 顶部的 `PALETTE` 即可。
4. **iOS 拿不到 MTU**，代码回退 185；安卓用 `requestMTU(247)`，实测单片 230 字节。
5. **固件无电量字段**，所以 App 里没有电量显示——不是漏做。
6. **相册权限**：Android 13+ 用的是照片选择器（Photo Picker），不需要全盘读取权限。

---

## 七、构建失败常见原因

| 现象 | 原因 / 处理 |
|---|---|
| `Invalid UUID appId` / 登录失败 | `eas login` 重登；公司网络可能拦了 expo.dev |
| Gradle 报 Bluetooth 权限冲突 | 检查 `app.json` 的 `android.permissions`，别自己重复加 |
| `npm install` peer 冲突 | `npx expo install --fix`，或删掉 `node_modules` + `package-lock.json` 重来 |
| 装到手机后扫不到设备 | Android 12+ 的"附近设备"权限没给；或设备未上电 |
| 连接后立刻断开 | 设备只允许**一个** BLE 连接，先把手机蓝牙设置里其他连着的断开 |

---

## 八、自动化构建（GitHub Actions）

`.github/workflows/android-apk.yml` 已配好：**推 tag → 协议自测 → EAS 云构建 → 自动挂到 Release**。

### 一次性准备（三件事）

1. **拿 Expo Token**
   <https://expo.dev/settings/access-tokens> → `Create token` → 复制
2. **加到仓库 Secret**
   GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret
   - Name: `EXPO_TOKEN`
   - Value: 刚才那串
3. **关联 EAS 项目**（本地跑一次，产物提交进仓库）
   ```bash
   eas init          # 会往 app.json 写入 extra.eas.projectId
   git add app.json && git commit -m "chore: link eas project"
   ```

> 第 3 步不做的话，CI 会在「检查 EAS 项目是否已关联」这一步直接报错退出，
> 而不是等到 EAS 端返回一个看不懂的错误码。

### 触发方式

```bash
git tag v1.0.0
git push origin v1.0.0
```

跑到 Actions 页面就能看到两个 job：

```
协议自测 (几秒)  →  EAS 云端构建 (10~40 分钟)  →  Release 自动创建
```

产物在 `Releases` 页：`epd-calendar-v1.0.0.apk` + `SHA256SUMS.txt`。

也可以手动触发（Actions → Android APK → Run workflow），能选 `preview` / `development`
两个 profile，以及是否创建草稿 Release。

### 工作流做了什么

| 步骤 | 作用 |
|---|---|
| 协议自测 | `node scripts/selftest.js`，31 项断言（CRC 标准向量、帧分片/粘包/CRC 错、命令字节布局、GET_INFO 字段、量化打包） |
| 检查 EXPO_TOKEN | 缺了直接给出获取地址，不让它跑到一半才挂 |
| 检查 projectId | 同上，提前失败 |
| `eas build --wait --json` | 阻塞等云端构建完成，输出机器可读结果 |
| `scripts/parse-build.js` | 解析 JSON，状态非 `FINISHED` 或缺产物 URL 就失败退出 |
| 下载并校验 | 检查文件头是 `PK`（真 APK），生成 SHA256 |
| Release | `softprops/action-gh-release`，带构建 ID、大小、SHA256 |

### 几个容易踩的坑

| 现象 | 原因 |
|---|---|
| `Missing EXPO_TOKEN` | Secret 没加，或加到了 Environment 而不是 Repository |
| `project is not linked` | `extra.eas.projectId` 缺失，跑 `eas init` |
| 下载到的是 HTML | 产物签名 URL 过期——工作流是构建完立刻下载，正常不会遇到；如果手动复制旧 URL 会 |
| 构建 3 分钟就失败 | 看 EAS 日志：多半是 `npm install` 版本冲突，本地先跑 `npx expo install --fix` 并提交 lockfile |
| Release 没生成 | 仓库 Settings → Actions → General → Workflow permissions 需要 **Read and write** |
| 免费额度用完 | EAS 免费账号每月构建次数有限，`concurrency` 已限制同一 ref 不并发，避免白白排队 |

### 省钱建议

- CI 里只跑 `preview`（APK）；`development` 留给本地热更新调试
- 自测 job 不花钱，代码改完先 `git push` 到分支让自测跑一遍，确认绿了再打 tag
- 真要连续试构建，用手动触发 + `draft` Release，别每次都打 tag
