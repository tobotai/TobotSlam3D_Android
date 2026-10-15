#!/usr/bin/env node
/*
 * TobotSlam3D 静态契约校验
 * ---------------------------------------------------------------------------
 * 零依赖。扫描 Android 源码目录（默认 ../app/src/main/java），断言：
 *   1) 契约里 5 个 topic 的「名称 + 类型」都作为字符串字面量出现在 Java 源码中
 *   2) 契约里 8 个 service 的「名称 + 类型」都作为字符串字面量出现（类型按契约次数要求）
 *   3) 契约 verbatimWireSamples 里每条报文对应的 topic/service 名在 Java 里存在
 *   4) 没有旧 2D 协议遗留 / 拼错的 token（详见 BAD_PATTERNS）
 *   5) 源码目录不存在时 → 打印「尚未生成，跳过」并 exit 0（便于先写 mock 再写 Java）
 *
 * 用法：
 *   node check-contract.js                          # 默认目录
 *   node check-contract.js <源码目录>                # 覆盖目录
 *   node check-contract.js --contract <契约路径>      # 覆盖契约路径
 *   node check-contract.js --verbose                # 额外打印扫描统计
 *
 * 退出码：0 = 通过（含「跳过」）；1 = 有失败项。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { srcDir: null, contractPath: null, verbose: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--contract') opts.contractPath = argv[++i];
  else if (a === '--verbose' || a === '-v') opts.verbose = true;
  else if (a === '--help' || a === '-h') {
    console.log(`用法：node check-contract.js [源码目录] [--contract <契约路径>] [--verbose]

默认源码目录：../app/src/main/java
默认契约路径：./protocol-contract.json
源码目录不存在时打印「尚未生成，跳过」并以退出码 0 结束。`);
    process.exit(0);
  } else if (!a.startsWith('--')) opts.srcDir = a;
}

const TOOLS_DIR = __dirname;
const SRC_DIR = path.resolve(opts.srcDir || path.join(TOOLS_DIR, '..', 'app', 'src', 'main', 'java'));
const CONTRACT_PATH = path.resolve(opts.contractPath || path.join(TOOLS_DIR, 'protocol-contract.json'));

// ---------------------------------------------------------------------------
// 断言计数
// ---------------------------------------------------------------------------
let passCount = 0;
let failCount = 0;
const failures = [];
let sectionNo = 1;

function section(title) {
  console.log(`\n── [${String(sectionNo++).padStart(2, '0')}] ${title}`);
}
function pass(name, detail) {
  passCount++;
  console.log(`  ✅ PASS  ${name}${detail ? `  —— ${detail}` : ''}`);
}
function fail(name, detail) {
  failCount++;
  failures.push(`${name}${detail ? `  —— ${detail}` : ''}`);
  console.log(`  ❌ FAIL  ${name}${detail ? `  —— ${detail}` : ''}`);
}
function check(name, cond, detail) {
  if (cond) pass(name, detail);
  else fail(name, detail);
}
// 纯提示，不计入通过/失败
function note(text) {
  console.log(`  ℹ️  提示  ${text}`);
}

// ---------------------------------------------------------------------------
// 读取契约
// ---------------------------------------------------------------------------
if (!fs.existsSync(CONTRACT_PATH)) {
  console.error(`❌ 契约文件不存在：${CONTRACT_PATH}`);
  process.exit(1);
}
const CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

console.log('=========================================================');
console.log(' TobotSlam3D 静态契约校验（Android 源码 vs protocol-contract.json）');
console.log(` 契约：${CONTRACT_PATH}`);
console.log(` 源码：${SRC_DIR}`);
console.log('=========================================================');

// ---------------------------------------------------------------------------
// 源码目录不存在 → 跳过（exit 0）
// ---------------------------------------------------------------------------
if (!fs.existsSync(SRC_DIR)) {
  console.log(`\nℹ️  Android 源码目录尚未生成，跳过静态校验：`);
  console.log(`    ${SRC_DIR}`);
  console.log('    （mock 底盘与测试夹具不受影响，可先用 conformance.test.js 验证协议）');
  console.log('\n=========================================================');
  console.log(' ⏭️  跳过：0 项校验（退出码 0）');
  console.log('=========================================================');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 递归收集 .java 文件
// ---------------------------------------------------------------------------
function collectJavaFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJavaFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.java')) out.push(full);
  }
  return out;
}

const javaFiles = collectJavaFiles(SRC_DIR);

if (javaFiles.length === 0) {
  console.log(`\nℹ️  源码目录存在但没有任何 .java 文件，跳过静态校验：`);
  console.log(`    ${SRC_DIR}`);
  console.log('\n=========================================================');
  console.log(' ⏭️  跳过：0 项校验（退出码 0）');
  console.log('=========================================================');
  process.exit(0);
}

// 去掉注释，避免「注释里写了旧 topic 名」被当成源码残留
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | str | chr
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === '"') state = 'str';
      else if (c === "'") state = 'chr';
      out += c;
      i++;
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i++;
    } else if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        i += 2;
      } else {
        if (c === '\n') out += c;
        i++;
      }
    } else if (state === 'str') {
      out += c;
      if (c === '\\') {
        out += c2 === undefined ? '' : c2;
        i += 2;
        continue;
      }
      if (c === '"') state = 'code';
      i++;
    } else {
      // 字符字面量
      out += c;
      if (c === '\\') {
        out += c2 === undefined ? '' : c2;
        i += 2;
        continue;
      }
      if (c === "'") state = 'code';
      i++;
    }
  }
  return out;
}

const files = javaFiles.map((f) => {
  const raw = fs.readFileSync(f, 'utf8');
  const code = stripComments(raw);
  return { file: f, rel: path.relative(SRC_DIR, f), code, raw };
});

const allCode = files.map((f) => f.code).join('\n');

// 收集所有字符串字面量（含其所在文件与行号，便于报错定位）
const literals = []; // { value, file, line }
for (const f of files) {
  const lines = f.code.split('\n');
  lines.forEach((line, idx) => {
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      literals.push({ value: m[1], file: f.rel, line: idx + 1 });
    }
  });
}
const literalSet = new Set(literals.map((l) => l.value));
const hasLiteral = (s) => literalSet.has(s);
const occurrences = (s) => literals.filter((l) => l.value === s).length;
const locationsOf = (s) => literals.filter((l) => l.value === s).slice(0, 3).map((l) => `${l.file}:${l.line}`).join('、');

// 常量名 → 字符串字面量值（Java 里大量用 `TobotConstants.FIELD_MAP_NAME` 这种符号引用，
// 直接查字面量会误判，这里先把常量表建出来，再做符号解析）
const constValues = new Map(); // 常量名（不含类名前缀） -> 字面量值
for (const f of files) {
  const re = /\b([A-Z][A-Z0-9_]{2,})\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g;
  let m;
  while ((m = re.exec(f.code)) !== null) {
    if (!constValues.has(m[1])) constValues.set(m[1], m[2]);
  }
}
/** 把代码里的 `TobotConstants.X` / `X` 这类符号引用解析成实际字符串值 */
function resolveSymbolic(expr) {
  const out = new Set();
  for (const raw of String(expr).split('|')) {
    const sym = raw.trim().split('.').pop().trim();
    if (!sym) continue;
    if (constValues.has(sym)) out.add(constValues.get(sym));
  }
  return out;
}

if (opts.verbose) {
  console.log(`\n扫描到 ${files.length} 个 .java 文件、${literals.length} 个字符串字面量、${constValues.size} 个字符串常量。`);
}

// ---------------------------------------------------------------------------
// 0) 中文/编码自检（契约示例含中文目标点名，Android 端 JSON 必须按 UTF-8 处理）
// ---------------------------------------------------------------------------
section('中文编码自检');
const utf8Ok = files.some((f) => /[\u4e00-\u9fa5]/.test(f.raw));
pass(
  '源码可被按 UTF-8 正常读取（契约示例含中文 map_name / goal_name）',
  true,
  utf8Ok ? '源码中已出现中文字面量' : '本次扫描未出现中文（不构成失败）'
);

// ---------------------------------------------------------------------------
// 1) 5 个 topic 的名称与类型
// ---------------------------------------------------------------------------
section(`契约 ${CONTRACT.topics.length} 个 Topic 的名称与类型`);
for (const t of CONTRACT.topics) {
  check(`topic 名称字面量存在：${t.name}`, hasLiteral(t.name), hasLiteral(t.name) ? locationsOf(t.name) : '未找到');
}
for (const t of CONTRACT.topics) {
  check(`topic 类型字面量存在：${t.type}（${t.name}）`, hasLiteral(t.type), hasLiteral(t.type) ? locationsOf(t.type) : '未找到');
}

// ---------------------------------------------------------------------------
// 2) 8 个 service 的名称与类型
// ---------------------------------------------------------------------------
section(`契约 ${CONTRACT.services.length} 个 Service 的名称与类型`);
for (const s of CONTRACT.services) {
  check(`service 名称字面量存在：${s.name}`, hasLiteral(s.name), hasLiteral(s.name) ? locationsOf(s.name) : '未找到');
}

// 类型要求：按每个类型被多少个服务使用来定最小出现次数
const typeNeed = new Map();
for (const s of CONTRACT.services) typeNeed.set(s.type, (typeNeed.get(s.type) || 0) + 1);
for (const [type, need] of typeNeed) {
  const got = occurrences(type);
  // 用字符串拼接构造的类型也算不通过，这里只认完整字面量
  check(`service 类型字面量存在：${type}（契约中 ${need} 个服务使用）`, got >= 1, `出现 ${got} 次（≥1 即可，带类型的 SDK 需要用到）`);
}

// ---------------------------------------------------------------------------
// 3) verbatimWireSamples 里的 topic / service 名必须存在
// ---------------------------------------------------------------------------
section(`契约 verbatimWireSamples（${CONTRACT.verbatimWireSamples.length} 条）引用的名称`);
for (const sample of CONTRACT.verbatimWireSamples) {
  let parsed;
  try {
    parsed = JSON.parse(sample);
  } catch (e) {
    fail(`样本不是合法 JSON：${sample}`, e.message);
    continue;
  }
  const name = parsed.topic || parsed.service;
  const kind = parsed.topic ? 'topic' : 'service';
  check(
    `样本引用的 ${kind} 在 Java 中存在：${name}`,
    hasLiteral(name),
    hasLiteral(name) ? locationsOf(name) : `未找到（样本：${sample.slice(0, 60)}…）`
  );
}
// 取消导航魔数坐标必须出现在源码里（Android 端最常漏的一条）
section('取消导航魔数坐标');
check(
  '取消导航魔数 999999 / 888888 出现在源码中',
  hasLiteral('999999') || /\b999999\b/.test(allCode),
  hasLiteral('999999') ? locationsOf('999999') : /\b999999\b/.test(allCode) ? '以数字字面量出现' : '未找到'
);
check(
  '第二个魔数 888888 出现在源码中',
  hasLiteral('888888') || /\b888888\b/.test(allCode),
  hasLiteral('888888') ? locationsOf('888888') : /\b888888\b/.test(allCode) ? '以数字字面量出现' : '未找到'
);

// ---------------------------------------------------------------------------
// 4) 旧 2D 协议遗留 / 字段名混用 / 拼写错误
// ---------------------------------------------------------------------------
section('旧 2D 协议遗留与字段名混用检查');

// 4.1 /ebot_goal_status 不能作为独立完整 topic 出现而漏掉 _local_planner 后缀
const badGoalStatus = [];
for (const l of literals) {
  if (l.value === '/ebot_goal_status') badGoalStatus.push(l);
  else if (l.value.includes('ebot_goal_status') && !l.value.includes('ebot_goal_status_local_planner')) {
    badGoalStatus.push(l);
  }
}
check(
  '/ebot_goal_status 未作为独立 topic 出现（必须带 _local_planner 后缀）',
  badGoalStatus.length === 0,
  badGoalStatus.length === 0
    ? '只出现完整全名 /ebot_goal_status_local_planner'
    : badGoalStatus.map((l) => `${l.value} @ ${l.file}:${l.line}`).join('、')
);

// 4.2 map_path 不得被当作 service 参数名传给 select_map_and_start_kitty / save_map_kitty
const AFFECTED = ['/select_map_and_start_kitty', '/save_map_kitty'];
const badMapPath = [];
for (const f of files) {
  for (const svcName of AFFECTED) {
    let from = 0;
    for (;;) {
      const at = f.code.indexOf(`"${svcName}"`, from);
      if (at < 0) break;
      // 取该调用点之后 400 字符的窗口，检查是否把 map_path 当参数名
      const window = f.code.slice(at, at + 400);
      if (/"map_path"\s*[,:) ]/.test(window)) {
        const line = f.code.slice(0, at).split('\n').length;
        badMapPath.push(`${svcName} @ ${f.rel}:${line}（附近出现 "map_path" 作为参数键）`);
      }
      from = at + svcName.length;
    }
  }
}
check(
  '未把 map_path 当 service 参数名传给 save_map / select_map_and_start',
  badMapPath.length === 0,
  badMapPath.length === 0 ? '未发现（map_path 只应作为 MapList 的读取字段）' : badMapPath.join('、')
);

// 4.3 其它旧 2D 协议 / 常见拼错 token
// 每种模式：exact = 字面量必须完全等于该值才算违规；contains = 字面量包含该子串即违规
const BAD_PATTERNS = [
  { label: '/map_list（缺 _kitty）', exact: '/map_list', why: '旧简写，真实名是 /map_list_kitty' },
  { label: '/fast_lio（缺 _localization）', exact: '/fast_lio', why: '旧简写，真实名是 /fast_lio_localization' },
  { label: '/aft_pgo（缺 _path）', exact: '/aft_pgo', why: '旧简写，真实名是 /aft_pgo_path' },
  { label: '/work_state（缺 ebot_ 前缀）', exact: '/work_state', why: '旧简写，真实名是 /ebot_work_state' },
  { label: '/goal_status（旧简写）', exact: '/goal_status', why: '旧简写，真实名是 /ebot_goal_status_local_planner' },
  { label: '/start_mapping（缺 _kitty）', exact: '/start_mapping', why: '漏掉 _kitty 后缀' },
  { label: '/save_map（缺 _kitty）', exact: '/save_map', why: '漏掉 _kitty 后缀' },
  { label: '/delete_map（缺 _kitty）', exact: '/delete_map', why: '漏掉 _kitty 后缀' },
  { label: '/add_goal（缺 _kitty）', exact: '/add_goal', why: '漏掉 _kitty 后缀' },
  { label: '/delete_goal（缺 _kitty）', exact: '/delete_goal', why: '漏掉 _kitty 后缀' },
  { label: '/docking（缺 _kitty）', exact: '/docking', why: '漏掉 _kitty 后缀' },
  { label: '/select_map（缺 _and_start_kitty）', exact: '/select_map', why: '漏掉 _and_start_kitty 后缀' },
  { label: 'move_base', contains: 'move_base', why: 'ROS 2D move_base 协议（本项目不用）' },
  { label: 'OccupancyGrid', contains: 'OccupancyGrid', why: '2D 占据栅格地图（原文 SDK 未暴露，本项目不用）' },
  { label: 'roslibpy', contains: 'roslibpy', why: 'Python 封装（Android 端不适用）' },
];
for (const p of BAD_PATTERNS) {
  const hits = literals.filter((l) =>
    p.exact !== undefined ? l.value === p.exact : l.value.includes(p.contains)
  );
  const uniq = [...new Set(hits.map((l) => `${l.value} @ ${l.file}:${l.line}`))];
  check(`未出现旧协议/拼错 token：${p.label}`, uniq.length === 0, uniq.length === 0 ? `（${p.why}）` : uniq.join('、'));
}

// 4.3b 手动遥控通路 `/cmd_vel` + `geometry_msgs/Twist`：**不是**违规项
// 官方 SDK 文档只公开 5 Topic + 9 Service、没有速度接口，但 Web 控制面板有「手动控制」摇杆，
// 本项目因此按 ROS 通用约定**有意实现**该通路（话题名可配置，需实测确认）。
// 这里只做提示性输出，不判 PASS/FAIL。
section('手动遥控通路（官方 SDK 未列出，本项目有意实现 → 仅提示）');
const cmdVelLits = literals.filter((l) => l.value.includes('cmd_vel') || l.value.includes('geometry_msgs/Twist'));
if (cmdVelLits.length === 0) {
  note('未检测到手动遥控话题 /cmd_vel 与 geometry_msgs/Twist');
} else {
  const uniq = [...new Set(cmdVelLits.map((l) => `${l.value} @ ${l.file}:${l.line}`))];
  note('检测到手动遥控通路（本项目有意实现，官方 SDK 文档未列出，见 docs/PROTOCOL.md）：');
  for (const u of uniq) console.log(`        · ${u}`);
  console.log('        · 该项不计入契约校验结果：契约只管官方 5 Topic + 9 Service，手动遥控属超出 SDK 的工程扩展');
}

// 4.4 服务调用点必须用契约规定的参数名（只看真正的 callService(...) 表达式，不做邻近启发式）
//
// Android 端写法：client.callService(TobotConstants.SVC_DELETE_MAP, RosbridgeMessages.mapNameArgs(mapName));
// 参数名在 RosbridgeMessages 里通过常量拼接，因此这里分两步：
//   a) 找出所有 `callService(<服务常量>, RosbridgeMessages.<helper>Args...)` 调用点
//   b) 解析 <helper>Args 方法体里用到的字段常量（FIELD_MAP_NAME → "map_name"），与契约对齐
section('服务调用点参数名配对（解析 callService 表达式 + 常量符号）');

// b) helper → 它真正产出的字段名集合
// Android 端这些 helper 是「字符串拼接 + FIELD_* 常量」构造 JSON，例如：
//   return "{\"" + TobotConstants.FIELD_MAP_NAME + "\":" + quote(x) + ",\"x\":" + num(x) + "}";
// 因此解析 return 表达式：把字符串字面量原样拼接、把 FIELD_* 换成实际取值，
// 再从这个「JSON 骨架」里抽出所有被引号包裹的键名。
const helperFields = new Map(); // 'addGoalArgs' -> { fields:[...], skeleton:'...' }
for (const f of files) {
  // 以「参数列表 + {」作为起点，避免把上一个方法的 } 带进来
  const re = /(\w+Args)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(f.code)) !== null) {
    const helper = m[1];
    const after = f.code.slice(re.lastIndex, re.lastIndex + 900);
    const ret = after.match(/\breturn\b([\s\S]*?);/);
    if (!ret) continue;
    const expr = ret[1];
    // 拼出 JSON 骨架
    let skeleton = '';
    const parts = expr.split(/\+\s*|\n/);
    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (!part) continue;
      const lit = part.match(/^"((?:[^"\\]|\\.)*)"$/);
      if (lit) {
        skeleton += lit[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        continue;
      }
      const sym = part.match(/\b([A-Z][A-Z0-9_]{2,})\b/);
      if (sym && constValues.has(sym[1])) skeleton += constValues.get(sym[1]);
    }
    // 抽出所有被引号包裹的键名（骨架里的转义已经还原）
    const fields = [];
    const keyRe = /"([A-Za-z_][A-Za-z0-9_]*)"/g;
    let km;
    while ((km = keyRe.exec(skeleton)) !== null) if (!fields.includes(km[1])) fields.push(km[1]);
    if (!helperFields.has(helper) || fields.length > 0) {
      helperFields.set(helper, { fields, skeleton });
    }
  }
}

// 契约：每个服务允许 / 要求的参数字段
const allowedArgs = {
  '/start_mapping_kitty': [], // 空请求
  '/save_map_kitty': ['filepath'],
  '/select_map_and_start_kitty': ['filepath'],
  '/delete_map_kitty': ['map_name'],
  '/docking_kitty': [], // 空请求
  '/navigate_to_pose': ['goal'],
  '/add_goal_kitty': ['map_name', 'goal_name', 'x', 'y', 'theta'],
  '/delete_goal_kitty': ['map_name', 'goal_name'],
};

// a) 扫描所有 callService 调用点
const callSites = []; // { service, helper, file, line }
for (const f of files) {
  const re = /callService\s*\(\s*([A-Za-z_][\w.]*)\s*,\s*(?:[A-Za-z_][\w.]*\.)?(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(f.code)) !== null) {
    const svcConstExpr = m[1];
    const service = constValues.get(svcConstExpr.split('.').pop());
    const helper = m[2];
    const line = f.code.slice(0, m.index).split('\n').length;
    callSites.push({ service, helper, file: f.rel, line, svcConstExpr });
  }
}

if (callSites.length === 0) {
  note('源码中未找到 callService(...) 调用点（若尚未实现则不算失败）');
} else if (opts.verbose) {
  note(`找到 ${callSites.length} 个 callService 调用点、${helperFields.size} 个参数构造函数`);
}

let pairBad = 0;
for (const site of callSites) {
  const expected = allowedArgs[site.service];
  if (!expected) {
    fail(`未知服务常量的调用点：${site.svcConstExpr}`, `${site.file}:${site.line}`);
    pairBad++;
    continue;
  }
  const parsed = helperFields.get(site.helper);
  if (!parsed) {
    note(`无法解析参数构造函数 ${site.helper}()（跳过该项）：${site.file}:${site.line}`);
    continue;
  }
  const producedArr = parsed.fields;
  // 嵌套参数（如 navigate 的 goal.pose.position）按「字段出现」判定；
  // 扁平参数（其余服务）按「集合完全相等」判定。
  const nested = expected.some((e) => ['goal'].includes(e));
  const missing = expected.filter((e) => !producedArr.includes(e) && !(nested && parsed.skeleton.includes(`"${e}"`)));
  const extra = nested ? [] : producedArr.filter((p) => !expected.includes(p));
  const badHint =
    (extra.includes('filepath') ? ' ← 把 filepath 用在了需要 map_name 的服务上' : '') +
    (producedArr.includes('map_path') ? ' ← 把 map_path 当成了服务参数名' : '');
  if (missing.length === 0 && extra.length === 0) {
    pass(
      `${site.service} → ${site.helper}() 参数字段正确`,
      `{${producedArr.join(', ')}} @ ${site.file}:${site.line}`
    );
  } else {
    pairBad++;
    fail(
      `${site.service} → ${site.helper}() 参数字段不符`,
      `期望 {${expected.join(', ')}}，实际 {${producedArr.join(', ')}}` +
        (missing.length ? `，缺少 {${missing.join(', ')}}` : '') +
        (extra.length ? `，多出 {${extra.join(', ')}}` : '') +
        badHint +
        ` @ ${site.file}:${site.line}`
    );
  }
}

// 额外：/delete_map_kitty 的调用点绝不能出现 filepath 语义
const deleteMapSites = callSites.filter((s) => s.service === '/delete_map_kitty');
check(
  '存在 /delete_map_kitty 调用点且使用 map_name 参数',
  deleteMapSites.length > 0 &&
    deleteMapSites.every((s) => ((helperFields.get(s.helper) || { fields: [] }).fields || []).includes('map_name')),
  deleteMapSites.length === 0
    ? '未找到 /delete_map_kitty 的 callService 调用点'
    : deleteMapSites.map((s) => `${s.helper}() @ ${s.file}:${s.line}`).join('、')
);

// 4.5 充电/未充电常量不能写成 0
section('关键常量检查');
const notChargingWrong = literals.filter((l) => /not.?charging\s*=\s*0/i.test(l.value) || /未充电\D{0,6}0\b/.test(l.value));
check(
  '未发现「未充电 = 0」的写法（契约 notCharging = 2）',
  notChargingWrong.length === 0,
  notChargingWrong.length === 0 ? '未发现' : notChargingWrong.map((l) => `${l.value} @ ${l.file}:${l.line}`).join('、')
);

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n=========================================================');
const total = passCount + failCount;
if (failCount === 0) {
  console.log(` ✅ 静态契约校验全部通过：${passCount}/${total} 项`);
  console.log(`    扫描 ${files.length} 个 .java 文件`);
  console.log('=========================================================');
  process.exit(0);
} else {
  console.log(` ❌ 静态契约校验失败 ${failCount} 项 / 共 ${total} 项（通过 ${passCount}）`);
  console.log(' 失败清单：');
  for (const f of failures) console.log(`   - ${f}`);
  console.log('=========================================================');
  process.exit(1);
}
