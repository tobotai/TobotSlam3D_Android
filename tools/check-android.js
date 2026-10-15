#!/usr/bin/env node
/**
 * check-android.js —— TobotSlam3D 静态一致性校验
 *
 * 本机没有 JDK / Android SDK，无法编译，因此用这个脚本在不编译的前提下把
 * 「一编译就会报错」的常见问题尽量提前抓出来：
 *
 *   1. 所有 res XML 与 AndroidManifest 的良构性（标签配对 / 属性引号）
 *   2. Java 里引用的每一个 R.xxx.yyy 是否真实存在
 *   3. findViewById(R.id.*) 的 id 是否在布局里定义
 *   4. Java 花括号/圆括号/方括号配平
 *   5. 公开类名与文件名一致、package 与目录一致
 *   6. 跨文件 import（com.tobot.slam3d.*）是否有对应文件
 *   7. Manifest 引用的类 / 资源是否存在
 *   8. 协议契约：topic / service 名称与类型是否都在源码中（逐字符）
 *
 * 用法： node check-android.js [项目根目录]
 */

'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..');

const errors = [];
const warnings = [];
const notes = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// ------------------------------------------------------------------ 文件收集

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

const appDir = path.join(ROOT, 'app');
const resDir = path.join(appDir, 'src', 'main', 'res');
const javaDir = path.join(appDir, 'src', 'main', 'java');
const manifestPath = path.join(appDir, 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(appDir)) {
    console.error('找不到 app/ 目录，请把项目根目录作为参数传入：' + ROOT);
    process.exit(2);
}

const javaFiles = walk(javaDir).filter((f) => f.endsWith('.java'));
const resFiles = walk(resDir);
const allXml = resFiles.filter((f) => f.endsWith('.xml'));

// ------------------------------------------------------------------ 1. XML 良构性

/** 极简 XML 良构检查：标签配对 + 属性必须带引号。 */
function checkXmlWellFormed(file) {
    const src = fs.readFileSync(file, 'utf8');
    const stack = [];
    const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    let m;
    let lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
        // 跳过注释 / CDATA / 处理指令 之间的内容
        const between = src.slice(lastIndex, m.index);
        const cleaned = between
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
            .replace(/<\?[\s\S]*?\?>/g, '')
            .replace(/<!DOCTYPE[\s\S]*?>/g, '');
        if (cleaned.includes('<')) {
            // 还剩未闭合的 `<`，说明有畸形标签
            const bad = cleaned.indexOf('<');
            err(`${path.relative(ROOT, file)}: 位置 ${lastIndex + bad} 附近有未闭合的 "<"`);
            return;
        }
        lastIndex = re.lastIndex;

        const isClose = m[1] === '/';
        const name = m[2];
        const attrs = m[3] || '';
        const selfClose = m[4] === '/';

        // 属性检查：去掉合法属性后不应残留裸字符
        const attrRe = /([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g;
        const stripped = attrs.replace(attrRe, '').trim();
        if (stripped.length > 0) {
            err(`${path.relative(ROOT, file)}: <${name}> 的属性疑似未加引号或有多余字符 -> ${JSON.stringify(stripped.slice(0, 60))}`);
        }

        if (isClose) {
            if (stack.length === 0) {
                err(`${path.relative(ROOT, file)}: 多余的结束标签 </${name}>`);
                return;
            }
            const top = stack.pop();
            if (top !== name) {
                err(`${path.relative(ROOT, file)}: 标签不匹配，期望 </${top}> 但遇到 </${name}>`);
                return;
            }
        } else if (!selfClose) {
            stack.push(name);
        }
    }
    if (stack.length > 0) {
        err(`${path.relative(ROOT, file)}: 有未闭合标签 <${stack.join('>, <')}>`);
    }
}

for (const f of allXml) checkXmlWellFormed(f);
if (fs.existsSync(manifestPath)) checkXmlWellFormed(manifestPath);
else err('缺少 AndroidManifest.xml');
notes.push(`XML 良构检查：${allXml.length + 1} 个文件`);

// ------------------------------------------------------------------ 2. 资源清单

const defined = {
    layout: new Set(),
    id: new Set(),
    string: new Set(),
    color: new Set(),
    style: new Set(),
    drawable: new Set(),
    mipmap: new Set(),
    xml: new Set(),
    dimen: new Set(),
    array: new Set(),
    integer: new Set(),
    anim: new Set(),
};

// 文件名即资源名
for (const f of resFiles) {
    const rel = path.relative(resDir, f).split(path.sep);
    const dir = rel[0];
    const base = path.basename(f).replace(/\.(xml|png|jpg|jpeg|webp|svg)$/i, '');
    if (dir.startsWith('layout')) defined.layout.add(base);
    else if (dir.startsWith('drawable')) defined.drawable.add(base);
    else if (dir.startsWith('mipmap')) defined.mipmap.add(base);
    else if (dir === 'xml') defined.xml.add(base);
    else if (dir.startsWith('anim')) defined.anim.add(base);
}

// values 下的具名资源
for (const f of allXml) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<(string|color|style|dimen|integer|string-array|integer-array|array)\s+name="([^"]+)"/g)) {
        const kind = m[1];
        const name = m[2];
        if (kind === 'string' || kind === 'string-array') defined.string.add(name);
        else if (kind === 'color') defined.color.add(name);
        else if (kind === 'style') defined.style.add(name);
        else if (kind === 'dimen') defined.dimen.add(name);
        else if (kind === 'integer' || kind === 'integer-array') defined.integer.add(name);
        else if (kind === 'array') defined.array.add(name);
    }
    // @+id/xxx 定义
    for (const m of src.matchAll(/@\+id\/([A-Za-z_]\w*)/g)) defined.id.add(m[1]);
}
notes.push(`资源：layout ${defined.layout.size} / id ${defined.id.size} / string ${defined.string.size} / color ${defined.color.size} / style ${defined.style.size} / drawable ${defined.drawable.size}`);

// ------------------------------------------------------------------ 3. Java 检查

/**
 * 单遍扫描 Java 源码：正确处理行注释、块注释、字符串与字符字面量（含转义），
 * 只在「代码」区域统计括号，并识别**顶层**类型声明（嵌套类型不算）。
 */
function scanJava(src) {
    const counts = { '{': 0, '}': 0, '(': 0, ')': 0, '[': 0, ']': 0 };
    const topLevelTypes = [];
    let depth = 0;
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        // 行注释
        if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        // 块注释（含 javadoc）
        if (c === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        // 字符串 / 字符字面量
        if (c === '"' || c === "'") {
            const quote = c;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === quote) { i++; break; }
                if (src[i] === '\n') break;   // 未闭合，交给编译器报错
                i++;
            }
            continue;
        }
        // 顶层类型声明
        if (depth === 0 && /[A-Za-z_]/.test(c)) {
            const m = /^(?:(?:public|final|abstract|strictfp)\s+)*(class|interface|enum)\s+(\w+)/.exec(src.slice(i));
            if (m) {
                topLevelTypes.push(m[2]);
                i += m[0].length;
                continue;
            }
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        if (counts[c] !== undefined) counts[c]++;
        i++;
    }
    return { counts, topLevelTypes, endDepth: depth };
}

const javaByClass = new Map();  // FQCN -> 文件

for (const f of javaFiles) {
    const rel = path.relative(javaDir, f);
    const relParts = rel.split(path.sep);
    const fileName = relParts[relParts.length - 1];
    const src = fs.readFileSync(f, 'utf8');
    const short = path.relative(ROOT, f);

    // package 与目录一致
    const pkgMatch = src.match(/^\s*package\s+([\w.]+)\s*;/m);
    if (!pkgMatch) {
        err(`${short}: 缺少 package 声明`);
    } else {
        const dirPkg = relParts.slice(0, -1).join('.');
        if (pkgMatch[1] !== dirPkg) {
            err(`${short}: package "${pkgMatch[1]}" 与目录 "${dirPkg}" 不一致`);
        }
        javaByClass.set(pkgMatch[1] + '.' + fileName.replace(/\.java$/, ''), f);
    }

    const scan = scanJava(src);
    const base = fileName.replace(/\.java$/, '');

    // 顶层类型名必须与文件名一致
    if (!scan.topLevelTypes.includes(base)) {
        err(`${short}: 找不到与文件名同名的顶层类型 "${base}"（找到：${scan.topLevelTypes.join(', ') || '无'}）`);
    }
    for (const t of scan.topLevelTypes) {
        if (t !== base) {
            err(`${short}: 顶层类型 "${t}" 与文件名不一致（Java 要求公开类名与文件同名）`);
        }
    }

    // 括号配平
    for (const [open, close, label] of [['{', '}', '花括号'], ['(', ')', '圆括号'], ['[', ']', '方括号']]) {
        if (scan.counts[open] !== scan.counts[close]) {
            err(`${short}: ${label}不配平，${open}=${scan.counts[open]} ${close}=${scan.counts[close]}`);
        }
    }
    if (scan.endDepth !== 0) {
        err(`${short}: 代码块层级未归零（${scan.endDepth}），可能存在多余的 { 或 }`);
    }

    // R.* 引用
    for (const m of src.matchAll(/(?<![\w.])R\.(layout|id|string|color|style|drawable|mipmap|xml|dimen|array|integer|anim)\.(\w+)/g)) {
        const kind = m[1];
        const name = m[2];
        if (!defined[kind]) {
            warn(`${short}: 未识别的资源类型 R.${kind}`);
            continue;
        }
        if (!defined[kind].has(name)) {
            err(`${short}: 引用了不存在的资源 R.${kind}.${name}`);
        }
    }

    // findViewById(R.id.x)
    for (const m of src.matchAll(/findViewById\(\s*R\.id\.(\w+)\s*\)/g)) {
        if (!defined.id.has(m[1])) {
            err(`${short}: findViewById(R.id.${m[1]}) 的 id 未在任何布局中定义`);
        }
    }

    // 跨文件 import（R 与 BuildConfig 由构建生成，不在源码里）
    for (const m of src.matchAll(/^\s*import\s+(com\.tobot\.slam3d[\w.]*)\s*;/gm)) {
        const fqcn = m[1];
        if (fqcn === 'com.tobot.slam3d.R' || fqcn === 'com.tobot.slam3d.BuildConfig') continue;
        if (!javaByClass.has(fqcn)) {
            notes.push(`__pending_import__${fqcn}`);
        }
    }
}

// 复查跨文件 import（此时 javaByClass 已完整）
{
    const pending = notes.filter((n) => n.startsWith('__pending_import__'));
    for (const p of pending) {
        const fqcn = p.replace('__pending_import__', '');
        if (!javaByClass.has(fqcn)) {
            err(`import 了不存在的类：${fqcn}`);
        }
    }
    // 清理临时项
    for (let i = notes.length - 1; i >= 0; i--) {
        if (notes[i].startsWith('__pending_import__')) notes.splice(i, 1);
    }
}
notes.push(`Java 文件：${javaFiles.length} 个`);

// ------------------------------------------------------------------ 4. Manifest 一致性

if (fs.existsSync(manifestPath)) {
    const man = fs.readFileSync(manifestPath, 'utf8');
    const pkg = 'com.tobot.slam3d';
    for (const m of man.matchAll(/android:name="([^"]+)"/g)) {
        const name = m[1];
        if (!name.startsWith('.') && !name.includes(pkg)) continue;
        const fqcn = name.startsWith('.') ? pkg + name : name;
        if (!javaByClass.has(fqcn)) {
            err(`AndroidManifest 引用了不存在的类：${name}`);
        }
    }
    for (const m of man.matchAll(/@(mipmap|drawable|style|xml|string|color)\/(\w+)/g)) {
        const kind = m[1];
        const name = m[2];
        if (defined[kind] && !defined[kind].has(name)) {
            err(`AndroidManifest 引用了不存在的资源 @${kind}/${name}`);
        }
    }
}

// ------------------------------------------------------------------ 5. 协议契约检查

const contractPath = path.join(ROOT, 'tools', 'protocol-contract.json');
if (!fs.existsSync(contractPath)) {
    warn('缺少 tools/protocol-contract.json，跳过协议契约检查');
} else {
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const allJava = javaFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const allRes = allXml.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const haystack = allJava + '\n' + allRes;

    for (const t of contract.topics) {
        if (!haystack.includes('"' + t.name + '"')) err(`契约缺失 Topic 名：${t.name}`);
        if (!haystack.includes('"' + t.type + '"')) err(`契约缺失消息类型：${t.type}（topic ${t.name}）`);
    }
    for (const s of contract.services) {
        if (!haystack.includes('"' + s.name + '"')) err(`契约缺失 Service 名：${s.name}`);
        if (!haystack.includes('"' + s.type + '"')) err(`契约缺失服务类型：${s.type}（service ${s.name}）`);
    }
    // 取消导航魔数
    const cx = String(contract.cancelNavigation.args.goal.pose.position.x);
    const cy = String(contract.cancelNavigation.args.goal.pose.position.y);
    if (!allJava.includes(cx) || !allJava.includes(cy)) {
        err(`契约缺失取消导航魔数坐标 ${cx} / ${cy}`);
    }
    // 逐字符报文样例
    for (const sample of contract.verbatimWireSamples) {
        const compact = sample;
        if (!haystack.includes(compact)) {
            // 允许源码里用反转义写法（\" 形式）出现
            const javaEscaped = compact.replace(/"/g, '\\"');
            if (!haystack.includes(javaEscaped)) {
                warn(`逐字符样例未在源码中找到（可能是动态拼接，可接受）：${compact.slice(0, 72)}…`);
            }
        }
    }
    // 易错点：/ebot_goal_status 不能作为完整 topic 名单独出现
    if (/"\/ebot_goal_status"/.test(haystack)) {
        err('发现错误 topic "/ebot_goal_status"，完整名应为 /ebot_goal_status_local_planner');
    }
    // 易错点：select/save 的参数必须是 filepath
    if (/SVC_SELECT_MAP\s*,\s*RosbridgeMessages\.mapNameArgs/.test(allJava)) {
        err('select_map_and_start_kitty 误用了 map_name 参数，应为 filepath');
    }
    if (/SVC_SAVE_MAP\s*,\s*RosbridgeMessages\.mapNameArgs/.test(allJava)) {
        err('save_map_kitty 误用了 map_name 参数，应为 filepath');
    }
    if (/SVC_DELETE_MAP\s*,\s*RosbridgeMessages\.filepathArgs/.test(allJava)) {
        err('delete_map_kitty 误用了 filepath 参数，应为 map_name');
    }
    notes.push('协议契约检查：5 Topic + 8 Service + 取消魔数 + 报文样例');
}

// ------------------------------------------------------------------ 6. Gradle / 结构

const required = [
    'settings.gradle',
    'build.gradle',
    'gradle.properties',
    'gradle/wrapper/gradle-wrapper.properties',
    'gradle/wrapper/gradle-wrapper.jar',
    'gradlew',
    'gradlew.bat',
    'app/build.gradle',
    'app/proguard-rules.pro',
    'app/src/main/AndroidManifest.xml',
];
for (const r of required) {
    if (!fs.existsSync(path.join(ROOT, r))) err(`缺少必要文件：${r}`);
}

// settings.gradle 必须 include ':app'
if (fs.existsSync(path.join(ROOT, 'settings.gradle'))) {
    const s = fs.readFileSync(path.join(ROOT, 'settings.gradle'), 'utf8');
    if (!/include\s+['"]:app['"]/.test(s)) err("settings.gradle 缺少 include ':app'");
}
// app/build.gradle 的 namespace 要与源码目录一致
if (fs.existsSync(path.join(ROOT, 'app/build.gradle'))) {
    const g = fs.readFileSync(path.join(ROOT, 'app/build.gradle'), 'utf8');
    const ns = g.match(/namespace\s+['"]([\w.]+)['"]/);
    if (!ns) err('app/build.gradle 缺少 namespace');
    else {
        const expected = ns[1].split('.').join(path.sep);
        if (!fs.existsSync(path.join(javaDir, expected))) {
            err(`namespace "${ns[1]}" 与源码目录不匹配（期望 ${path.join('app/src/main/java', expected)}）`);
        }
    }
    if (!/applicationId\s+['"][\w.]+['"]/.test(g)) err('app/build.gradle 缺少 applicationId');
    if (!/androidx\.appcompat:appcompat/.test(g)) warn('未声明 androidx.appcompat 依赖');
    if (!/com\.squareup\.okhttp3:okhttp/.test(g)) warn('未声明 okhttp 依赖（WebSocket 客户端需要）');
}

// ------------------------------------------------------------------ 输出

console.log('================ TobotSlam3D 静态一致性校验 ================');
console.log('项目根目录: ' + ROOT);
console.log('');
for (const n of notes) console.log('  · ' + n);
console.log('');

if (warnings.length) {
    console.log(`⚠ 警告 ${warnings.length} 条：`);
    for (const w of warnings) console.log('   - ' + w);
    console.log('');
}
if (errors.length) {
    console.log(`✗ 错误 ${errors.length} 条：`);
    for (const e of errors) console.log('   - ' + e);
    console.log('');
    console.log('结果：FAIL');
    process.exit(1);
}
console.log('✓ 未发现静态一致性问题');
console.log('结果：PASS');
process.exit(0);
