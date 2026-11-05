/**
 * EAS 构建结果解析器
 *
 * 用法：node scripts/parse-build.js eas-build.json
 *
 * 输入：`eas build --json` 的输出（始终是数组，即使只有一个构建）。
 *       EAS 有时会把日志混进 stdout，所以这里做容错：先整体解析，
 *       失败则从最后一个以 '[' 开头的行开始再试一次。
 *
 * 输出：key=value 行；设置了 GITHUB_OUTPUT 时同时追加到该文件。
 * 退出码：构建未成功或拿不到产物地址 → 1，让工作流明确失败。
 */

const fs = require('fs');

const file = process.argv[2] || 'eas-build.json';

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return undefined;
  }
}

function extract(text) {
  // 1) 整体就是 JSON
  let v = tryParse(text.trim());
  if (v !== undefined) return v;

  // 2) 找最后一个以 '[' 开头的行（EAS 的 JSON 总在最后）
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith('[')) {
      v = tryParse(lines.slice(i).join('\n').trim());
      if (v !== undefined) return v;
    }
  }

  // 3) 兜底：从第一个 '[' 截到最后一个 ']'
  const s = text.indexOf('[');
  const e = text.lastIndexOf(']');
  if (s >= 0 && e > s) {
    v = tryParse(text.slice(s, e + 1));
    if (v !== undefined) return v;
  }
  return undefined;
}

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.error(`读不到 ${file}: ${e.message}`);
  process.exit(1);
}

const parsed = extract(text);
if (parsed === undefined) {
  console.error(`${file} 里找不到合法 JSON`);
  process.exit(1);
}

const build = Array.isArray(parsed) ? parsed[0] : parsed;
if (!build) {
  console.error('EAS 返回了空结果');
  process.exit(1);
}

const status = build.status || 'UNKNOWN';
const id = build.id || '';
const platform = build.platform || 'android';
const profile = build.buildProfile || '';
const url = (build.artifacts && build.artifacts.buildUrl) || '';

if (status !== 'FINISHED') {
  console.error(`构建未成功：status=${status}`);
  if (build.error && build.error.message) console.error(`错误：${build.error.message}`);
  if (build.id) console.error(`构建 ID：${build.id}`);
  process.exit(1);
}
if (!url) {
  console.error('构建成功但没有 artifacts.buildUrl（profile 里是否设置了 buildType: apk？）');
  process.exit(1);
}

const lines = [
  `status=${status}`,
  `build_id=${id}`,
  `platform=${platform}`,
  `profile=${profile}`,
  `artifact_url=${url}`,
].join('\n');

console.log(lines);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
}
