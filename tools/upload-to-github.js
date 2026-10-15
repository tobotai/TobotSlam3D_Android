#!/usr/bin/env node
/**
 * upload-to-github.js —— 把 TobotSlam3D 上传到 GitHub（不需要本机安装 git）
 *
 * 走 GitHub REST API 的 Git Data API：blobs → tree → commit → ref。
 * 这样即使机器上没有 git、PowerShell 连不上 GitHub（schannel 报错）也能完成上传，
 * 因为 Node 的 fetch 访问 api.github.com 是通的（已实测）。
 *
 * 用法：
 *   # 1) 默认是「预演」，什么都不写，只打印计划
 *   node upload-to-github.js --token-file C:\Users\zzb\.dsh\gh_token.txt
 *
 *   # 2) 确认无误后真正上传
 *   node upload-to-github.js --token-file C:\Users\zzb\.dsh\gh_token.txt --apply
 *
 *   # 3) 私有/公开切换（默认 private）
 *   node upload-to-github.js --token-file ... --apply --visibility public
 *
 * 参数：
 *   --owner <name>       默认 tobotai
 *   --repo <name>        默认 TobotSlam3D_Android
 *   --visibility <v>     private | public，默认 private
 *   --src <dir>          默认本脚本上一级目录（TobotSlam3D/）
 *   --branch <name>      默认 main
 *   --token-file <path>  读取 PAT 的文件（也可用环境变量 GH_TOKEN）
 *   --apply              真正执行（不加则只预演）
 *
 * Token 权限：经典 token 勾 `repo`；细粒度 token 需目标仓库的
 *            Administration(读写) + Contents(读写)。
 */

'use strict';
const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------------ 参数解析

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
        return process.argv[i + 1];
    }
    return def;
}
const APPLY = process.argv.includes('--apply');
const OWNER = arg('owner', 'tobotai');
const REPO = arg('repo', 'TobotSlam3D_Android');
const VISIBILITY = arg('visibility', 'private');
const BRANCH = arg('branch', 'main');
const SRC = path.resolve(arg('src', path.join(__dirname, '..')));
const TOKEN_FILE = arg('token-file', null);

const API = 'https://api.github.com';
const LIST_ONLY = process.argv.includes('--list-only');

if (VISIBILITY !== 'private' && VISIBILITY !== 'public') {
    console.error('--visibility 只能是 private 或 public');
    process.exit(2);
}

// ------------------------------------------------------------------ Token

function readToken() {
    if (process.env.GH_TOKEN) {
        return process.env.GH_TOKEN.trim();
    }
    if (TOKEN_FILE && fs.existsSync(TOKEN_FILE)) {
        const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        if (t) return t;
    }
    return null;
}

const TOKEN = readToken();
if (!TOKEN && !LIST_ONLY) {
    console.error('缺少 token。请用 --token-file <路径> 指定存放 PAT 的文件，或设置环境变量 GH_TOKEN。');
    console.error('（若只想看会上传哪些文件，可加 --list-only，不需要 token）');
    process.exit(2);
}

// ------------------------------------------------------------------ HTTP 封装

async function gh(method, endpoint, body) {
    const res = await fetch(API + endpoint, {
        method,
        headers: {
            Authorization: 'Bearer ' + TOKEN,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'TobotSlam3D-uploader',
            'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 响应 */ }
    if (!res.ok) {
        const err = new Error(`${method} ${endpoint} -> HTTP ${res.status} ${json && json.message ? json.message : text.slice(0, 200)}`);
        err.status = res.status;
        err.body = json;
        throw err;
    }
    return json;
}

// ------------------------------------------------------------------ 收集文件

/** 与 .gitignore 对齐的最小子集；宁可少传也不要把构建产物传上去 */
const IGNORE_DIRS = new Set(['.gradle', 'build', '.idea', '.git', '.cxx', 'captures']);
const IGNORE_FILES = new Set(['local.properties', '.DS_Store', 'Thumbs.db']);
const IGNORE_EXT = new Set(['.apk', '.aab', '.iml', '.keystore', '.jks', '.hprof']);

function collect(dir, base, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        const rel = path.relative(base, full).split(path.sep).join('/');
        if (e.isDirectory()) {
            if (IGNORE_DIRS.has(e.name)) continue;
            collect(full, base, out);
        } else {
            if (IGNORE_FILES.has(e.name)) continue;
            if (IGNORE_EXT.has(path.extname(e.name).toLowerCase())) continue;
            if (e.name.endsWith('.bak') || e.name.startsWith('_')) continue;
            const buf = fs.readFileSync(full);
            // 文本文件用 utf8 blob，二进制用 base64
            const isText = /\.(java|xml|gradle|properties|md|json|js|txt|gitignore|pro|sample|bat)$/i.test(e.name)
                || e.name === 'gradlew';
            out.push({
                rel,
                buf,
                size: buf.length,
                encoding: isText ? 'utf-8' : 'base64',
            });
        }
    }
    return out;
}

// ------------------------------------------------------------------ 主流程

(async () => {
    console.log('================ 上传 TobotSlam3D 到 GitHub ================');
    console.log(`模式      : ${APPLY ? '★ APPLY（真正上传）' : '预演（不做任何修改）'}`);
    console.log(`目标仓库  : ${OWNER}/${REPO}  (${VISIBILITY})`);
    console.log(`分支      : ${BRANCH}`);
    console.log(`源目录    : ${SRC}`);
    console.log('');

    // 0) 只列清单模式：不联网、不需要 token
    if (LIST_ONLY) {
        if (!fs.existsSync(SRC)) {
            console.error(`源目录不存在：${SRC}`);
            process.exit(2);
        }
        const list = collect(SRC, SRC, []);
        const bytes = list.reduce((s, f) => s + f.size, 0);
        console.log(`源目录    : ${SRC}`);
        console.log(`共 ${list.length} 个文件，${(bytes / 1024).toFixed(1)} KB\n`);
        for (const f of list) {
            console.log(`  ${String(f.size).padStart(7)}  ${f.encoding === 'base64' ? '[bin]' : '     '}  ${f.rel}`);
        }
        const bin = list.filter((f) => f.encoding === 'base64').length;
        console.log(`\n其中二进制 ${bin} 个（base64 上传），文本 ${list.length - bin} 个（utf-8 上传）。`);
        return;
    }

    // 1) 校验 token 与身份
    const me = await gh('GET', '/user');
    console.log(`✓ Token 有效，身份：${me.login}（${me.name || '未填姓名'}）`);
    if (me.login.toLowerCase() !== OWNER.toLowerCase()) {
        console.log(`  ⚠ 注意：token 属于 "${me.login}"，但目标 owner 是 "${OWNER}"。`);
        console.log(`    只有 token 属于该 owner、或该 owner 把 token 持有者加为协作者时才能推送。`);
    }

    // 2) 收集并汇总文件
    if (!fs.existsSync(SRC)) {
        console.error(`源目录不存在：${SRC}`);
        process.exit(2);
    }
    const files = collect(SRC, SRC, []);
    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    console.log(`\n将上传 ${files.length} 个文件，共 ${(totalBytes / 1024).toFixed(1)} KB：`);
    const byDir = {};
    for (const f of files) {
        const d = path.dirname(f.rel);
        byDir[d === '.' ? '(根目录)' : d] = (byDir[d === '.' ? '(根目录)' : d] || 0) + 1;
    }
    for (const d of Object.keys(byDir).sort()) {
        console.log(`   ${d.padEnd(46)} ${byDir[d]} 个`);
    }

    // 3) 仓库是否存在
    let repoExists = false;
    try {
        const r = await gh('GET', `/repos/${OWNER}/${REPO}`);
        repoExists = true;
        console.log(`\n✓ 仓库已存在：${r.html_url}（默认分支 ${r.default_branch}，${r.private ? '私有' : '公开'}）`);
    } catch (e) {
        if (e.status === 404) {
            console.log(`\n· 仓库 ${OWNER}/${REPO} 尚不存在，将新建（${VISIBILITY}）`);
        } else {
            throw e;
        }
    }

    if (!APPLY) {
        console.log('\n--- 预演结束，未做任何修改 ---');
        console.log('确认无误后加 --apply 真正执行：');
        console.log(`  node ${path.basename(__filename)} --token-file <token文件> --apply --visibility ${VISIBILITY}`);
        return;
    }

    // 4) 建仓
    if (!repoExists) {
        const created = await gh('POST', '/user/repos', {
            name: REPO,
            private: VISIBILITY === 'private',
            description: 'TobotSlam3D —— Tbot 3D 激光雷达导航底盘 Android 控制端（rosbridge WebSocket）',
            has_issues: true,
            has_wiki: false,
            has_projects: false,
            auto_init: false,
        });
        console.log(`✓ 仓库已创建：${created.html_url}`);
    }

    // 5) 逐个上传 blob
    console.log(`\n上传 blob（${files.length} 个）…`);
    const tree = [];
    let done = 0;
    for (const f of files) {
        const content = f.encoding === 'base64' ? f.buf.toString('base64') : f.buf.toString('utf8');
        const blob = await gh('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
            content,
            encoding: f.encoding,
        });
        tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
        done++;
        if (done % 10 === 0 || done === files.length) {
            process.stdout.write(`\r  已完成 ${done}/${files.length}`);
        }
    }
    console.log('');

    // 6) 建 tree
    const treeRes = await gh('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree });
    console.log(`✓ tree 已创建：${treeRes.sha.slice(0, 10)}`);

    // 7) 建 commit（若目标分支已存在则带上父提交）
    let parents = [];
    try {
        const ref = await gh('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
        parents = [ref.object.sha];
        console.log(`· 分支 ${BRANCH} 已存在，作为父提交：${ref.object.sha.slice(0, 10)}`);
    } catch (e) {
        if (e.status !== 404) throw e;
        console.log(`· 分支 ${BRANCH} 不存在，将创建首个提交`);
    }

    const commit = await gh('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
        message: 'TobotSlam3D: 基于 3D 雷达 SLAM 接口协议的 Android 控制端\n\n'
            + '· 通信层重写为 rosbridge WebSocket（5 Topic + 9 项 Service），零闭源依赖\n'
            + '· 自研 PathCanvasView 路径画布与 JoystickView 摇杆\n'
            + '· 附零依赖 mock 底盘与静态契约校验工具',
        tree: treeRes.sha,
        parents,
    });
    console.log(`✓ commit 已创建：${commit.sha.slice(0, 10)}`);

    // 8) 建/更新 ref
    if (parents.length === 0) {
        await gh('POST', `/repos/${OWNER}/${REPO}/git/refs`, {
            ref: `refs/heads/${BRANCH}`,
            sha: commit.sha,
        });
        console.log(`✓ 分支 ${BRANCH} 已创建`);
    } else {
        await gh('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
            sha: commit.sha,
            force: false,
        });
        console.log(`✓ 分支 ${BRANCH} 已更新`);
    }

    // 9) 补一些仓库元信息（失败不影响主流程）
    try {
        await gh('PATCH', `/repos/${OWNER}/${REPO}`, {
            description: 'TobotSlam3D —— Tbot 3D 激光雷达导航底盘 Android 控制端（rosbridge WebSocket）',
            homepage: 'https://www.tobotai.com/sdk/index.html',
        });
        await gh('PUT', `/repos/${OWNER}/${REPO}/topics`, {
            names: ['android', 'ros', 'rosbridge', 'slam', 'lidar', 'robot', 'tobot'],
        });
        console.log('✓ 仓库描述与 topics 已设置');
    } catch (e) {
        console.log(`· 元信息设置跳过（${e.message}）`);
    }

    console.log(`\n🎉 完成：https://github.com/${OWNER}/${REPO}`);
})().catch((e) => {
    console.error('\n✗ 失败：' + e.message);
    if (e.status === 401) console.error('  → token 无效或已过期');
    if (e.status === 403) console.error('  → token 权限不足（经典 token 需勾 repo；细粒度需 Administration + Contents 读写）');
    if (e.status === 404 && /repos/.test(e.message)) console.error('  → 仓库不存在，或 token 无权访问该 owner');
    if (e.status === 422) console.error('  → 参数被拒绝：' + JSON.stringify(e.body && e.body.errors));
    process.exit(1);
});
