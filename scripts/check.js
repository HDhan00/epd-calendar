/**
 * 静态自检（node scripts/check.js）
 *
 * 覆盖那些「语法没错、但一跑就崩」的问题：
 *   1. 本地 import 路径是否存在（拼错/文件被删）
 *   2. import 的第三方包是否在 package.json 里声明（运行时 "Cannot find module"）
 *   3. 样式键是否真的定义在 theme.js 里（拼错就是一片空白）
 *   4. 是否误用了 Node 才有的全局（Buffer / process.env / fs）
 *   5. app.json 的 plugins 是否都已安装
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗ ' + msg); };
const pass = (msg) => console.log('  ✓ ' + msg);

function walkFiles(dir, ext, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (f !== 'node_modules') walkFiles(p, ext, out);
    } else if (f.endsWith(ext)) out.push(p);
  }
  return out;
}

const jsFiles = [
  path.join(ROOT, 'App.js'),
  path.join(ROOT, 'index.js'),
  ...walkFiles(SRC, '.js'),
].filter((f) => fs.existsSync(f));

const NODE_BUILTINS = new Set(['path', 'fs', 'crypto', 'zlib', 'events', 'stream']);

/* ---------------------------------------------------- 1. 本地 import 解析 -- */

console.log('\n[1] 本地 import 路径');
const importRe = /(?:import[\s\S]*?from\s+|require\()\s*['"](\.[^'"]+)['"]/g;
for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = importRe.exec(code))) {
    const spec = m[1];
    const base = path.resolve(path.dirname(file), spec);
    const candidates = [base, base + '.js', base + '.jsx', base + '.json',
      path.join(base, 'index.js'), path.join(base, 'index.jsx')];
    if (!candidates.some((c) => fs.existsSync(c))) {
      fail(`${path.relative(ROOT, file)} → 找不到 "${spec}"`);
    }
  }
}
if (!failures) pass(`${jsFiles.length} 个文件的相对路径都能解析`);

/* ------------------------------------------------- 2. 第三方依赖是否声明 -- */

console.log('\n[2] 第三方依赖声明');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);

const used = new Map();

const pkgRe = /(?:import[\s\S]*?from\s+|require\()\s*['"]([^.'"][^'"]*)['"]/g;
for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = pkgRe.exec(code))) {
    const spec = m[1];
    const name = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0];
    if (NODE_BUILTINS.has(name)) continue;
    if (!used.has(name)) used.set(name, new Set());
    used.get(name).add(path.relative(ROOT, file));
  }
}
for (const [name, files] of used) {
  if (!declared.has(name)) {
    fail(`"${name}" 被 ${[...files].join(', ')} 引用，但 package.json 未声明`);
  }
}
const unusedDeclared = [...declared].filter((d) => !used.has(d) && !d.startsWith('@babel') && d !== '@types/react');
if (!failures) {
  pass(`${used.size} 个第三方包全部已声明`);
  if (unusedDeclared.length) console.log('  · 已声明但未被引用（可清理）:', unusedDeclared.join(', '));
}

/* ------------------------------------------------------ 3. 样式键是否定义 -- */

console.log('\n[3] 样式键');
const themeSrc = fs.readFileSync(path.join(SRC, 'theme.js'), 'utf8');
const defined = new Set([...themeSrc.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
const styleUsed = new Map();
for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8');
  // 只有 import { s } from '../theme' 的文件里，s 才是样式对象；
  // 其它文件（如 protocol.js）里的 s 可能只是个字符串变量，不能误判
  if (!/import\s*\{[^}]*\bs\b[^}]*\}\s*from\s*['"][^'"]*theme['"]/.test(code)) continue;
  for (const m of code.matchAll(/\bs\.([A-Za-z][A-Za-z0-9_]*)/g)) {
    if (!styleUsed.has(m[1])) styleUsed.set(m[1], new Set());
    styleUsed.get(m[1]).add(path.relative(ROOT, file));
  }
}
for (const [key, files] of styleUsed) {
  if (!defined.has(key)) fail(`s.${key} 未在 theme.js 定义（${[...files].join(', ')}）`);
}
if (![...styleUsed.keys()].some((k) => !defined.has(k))) {
  pass(`${styleUsed.size} 个样式键全部有定义`);
}

/* ------------------------------------------------ 4. 误用 Node 全局/API -- */

console.log('\n[4] Node 专有 API');
const forbidden = [
  [/\bBuffer\.(from|alloc)\b/, 'Buffer（RN 里没有，需要 base64 请用项目自带实现）'],
  [/process\.env\./, 'process.env（打包后不存在）'],
  [/require\(['"]fs['"]\)/, "require('fs')"],
];
let hit = false;
for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8');
  for (const [re, label] of forbidden) {
    if (re.test(code) && !file.endsWith('check.js') && !file.endsWith('selftest.js')) {
      fail(`${path.relative(ROOT, file)} 使用了 ${label}`);
      hit = true;
    }
  }
}
if (!hit) pass('没有误用 Node 专有 API');

/* --------------------------------------------------- 5. app.json 插件 --- */

console.log('\n[5] app.json');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const expo = appJson.expo || {};
const plugins = (expo.plugins || []).map((p) => (Array.isArray(p) ? p[0] : p));
for (const p of plugins) {
  if (!declared.has(p)) fail(`插件 "${p}" 未安装`);
}
if (plugins.every((p) => declared.has(p))) pass(`插件 ${plugins.length} 个均已安装`);

const perms = (expo.android && expo.android.permissions) || [];
const need = ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT'];
for (const n of need) {
  if (!perms.includes(n)) fail(`app.json 缺少权限 ${n}`);
}
if (need.every((n) => perms.includes(n))) pass('蓝牙权限已在 manifest 声明');

if (!expo.extra || !expo.extra.eas || !expo.extra.eas.projectId) {
  fail('缺少 extra.eas.projectId（EAS 无法定位项目）');
} else {
  pass(`projectId = ${expo.extra.eas.projectId.slice(0, 8)}…`);
}

/* ------------------------------------------------------------- 汇总 ----- */

console.log('');
if (failures) {
  console.error(`❌ ${failures} 项未通过`);
  process.exit(1);
}
console.log('✅ 静态自检全部通过');
