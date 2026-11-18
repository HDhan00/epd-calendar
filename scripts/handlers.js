/**
 * 检查 JSX 里引用的事件处理函数是否真的存在。
 *
 * 之所以专门查这个：曾经出现过按钮引用了 onSatLevel，但这个函数根本没定义，
 * 一点就 TypeError → 整个 App 闪退。Babel/Metro 只做转译，不做作用域检查，
 * 这类错误只有在用户点下去的那一刻才炸。
 *
 * 判定的"已定义"来源：
 *   1) const NAME = ... / function NAME
 *   2) useState 的 setter（const [x, setX] = useState(...)）
 *   3) 从 ctx / props 解构出来的名字
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const screens = ['PhotoScreen', 'DeviceScreen', 'ConfigScreen', 'WifiScreen']
  .map((n) => path.join(ROOT, 'src', 'screens', n + '.js'))
  .filter(fs.existsSync);

let bad = 0;

for (const file of screens) {
  const code = fs.readFileSync(file, 'utf8');
  const defined = new Set();

  // 1) const NAME = / function NAME
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);

  // 2) useState setter
  for (const m of code.matchAll(/const\s*\[\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*useState/g)) {
    defined.add(m[1]);
  }

  // 3) 从 ctx 解构：const { a, b, c } = ctx;
  for (const m of code.matchAll(/const\s*\{([^}]+)\}\s*=\s*ctx/g)) {
    m[1].split(',').forEach((piece) => {
      const name = piece.split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
    });
  }

  // JSX 中引用的处理函数
  const used = new Set();
  for (const m of code.matchAll(/on(?:Press|LongPress|Change|ChangeText|SubmitEditing)=\{\(\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[1]);
  for (const m of code.matchAll(/on(?:Press|LongPress)=\{([A-Za-z_$][\w$]*)\}/g)) used.add(m[1]);
  for (const m of code.matchAll(/onChangeText=\{([A-Za-z_$][\w$]*)\}/g)) used.add(m[1]);
  for (const m of code.matchAll(/setInterval\(\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)\(/g)) used.add(m[1]);

  const missing = [...used].filter((fn) => !defined.has(fn));
  const rel = path.relative(ROOT, file);
  if (missing.length) {
    bad++;
    console.log(`  ✗ ${rel} 引用了未定义的处理函数: ${missing.join(', ')}`);
  } else {
    console.log(`  ✓ ${rel} 事件处理函数全部有定义（${used.size} 个）`);
  }
}

console.log('');
if (bad) { console.error(`❌ ${bad} 个文件有问题`); process.exit(1); }
console.log('✅ 处理函数检查通过');
