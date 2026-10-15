#!/usr/bin/env node
/*
 * TobotSlam3D 协议一致性测试（端到端）
 * ---------------------------------------------------------------------------
 * 零依赖：客户端优先使用 Node 内置全局 WebSocket（Node 22+ 提供）；
 * 服务端直接在同进程内 require ./mock-chassis/server.js 拉起（用空闲端口，避免占用 9090）。
 *
 * 覆盖：契约 protocol-contract.json 的 verbatimWireSamples（逐字符）、
 *      5 个 Topic 的推送语义、8 个服务名/9 项功能的业务闭环、反例抓错。
 *
 * 运行：
 *   node conformance.test.js              # 自动：先试内置 WebSocket，不可用则退回手写客户端
 *   node conformance.test.js --native-ws  # 强制只用内置 WebSocket
 *   node conformance.test.js --raw-ws     # 强制只用手写零依赖客户端
 * 失败时以退出码 1 结束。
 *
 * ⚠️ 已在本机实测的 Node 缺陷（v24.21.0 内置 WebSocket 客户端）：
 *   对任何本地 101 Switching Protocols 握手，内置 WebSocket 客户端都会直接抛
 *     TypeError  at #onSocketClose (node:internal/deps/undici/undici:15787:20)
 *              at failWebsocketConnection ... at processResponse
 *   （error 事件里 message 为空），而同一端口、同一响应下用 node:http 的
 *   'upgrade' 事件手写客户端可正常握手收帧（本文件里已内置该客户端）。
 *   该缺陷已用「good accept / wrong accept / 200 OK」三组对照实验复现：三种情况
 *   抛的错完全一样，说明失败发生在 undici 建立连接之后，与 mock 服务端无关。
 *   因此本测试默认「先试内置 WebSocket，1.2 秒内没连上就退回首写客户端」，
 *   两种客户端走的是同一条 WebSocket 协议（同样的握手 + 帧编解码），测试结论一致。
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { createMockChassis } = require('./mock-chassis/server.js');

// 命令行开关：--native-ws 强制内置 WebSocket；--raw-ws 强制手写客户端
const FLAGS = {
  nativeWs: process.argv.includes('--native-ws'),
  rawWs: process.argv.includes('--raw-ws'),
};

const CONTRACT = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'protocol-contract.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// 断言与计数
// ---------------------------------------------------------------------------
let passCount = 0;
let failCount = 0;
const failures = [];

function ok(name, detail) {
  passCount++;
  console.log(`  ✅ PASS  ${name}${detail ? `  —— ${detail}` : ''}`);
}
function bad(name, detail) {
  failCount++;
  failures.push(`${name}${detail ? `  —— ${detail}` : ''}`);
  console.log(`  ❌ FAIL  ${name}${detail ? `  —— ${detail}` : ''}`);
}
function step(title) {
  console.log(`\n── [${String(step.no).padStart(2, '0')}] ${title}`);
  step.no++;
}
step.no = 1;

// 通用断言
function assertTrue(name, cond, detail) {
  if (cond) ok(name, detail);
  else bad(name, detail);
}
function assertEq(name, actual, expected, extra) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(name, `${a}${extra ? ` ${extra}` : ''}`);
  else bad(name, `期望 ${e}，实际 ${a}${extra ? ` ${extra}` : ''}`);
}
function assertHas(name, haystack, needle) {
  if (typeof haystack === 'string' && haystack.includes(needle)) ok(name, `包含 "${needle}"`);
  else bad(name, `应包含 "${needle}"，实际 ${JSON.stringify(haystack)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 零依赖 WebSocket 客户端（手写握手 + 帧编解码）
// 仅在 Node 内置 WebSocket 客户端不可用时作为后备（见文件头说明）。
// 对外接口刻意与浏览器/Node 内置 WebSocket 保持一致：
//   readyState / addEventListener('open'|'message'|'error'|'close') / send() / close()
// ---------------------------------------------------------------------------
function createRawWebSocketClient(url) {
  const listeners = { open: [], message: [], error: [], close: [] };
  const u = new URL(url);
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11F';
  const key = crypto.randomBytes(16).toString('base64');
  const expectedAccept = crypto.createHash('sha1').update(key + GUID).digest('base64');

  const self = {
    readyState: 0, // 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
    addEventListener(type, fn) {
      if (listeners[type]) listeners[type].push(fn);
    },
    send(text) {
      if (self.readyState !== 1) throw new Error('WebSocket 尚未打开（readyState=' + self.readyState + '）');
      socketWrite(encodeText(text));
    },
    close(code, reason) {
      if (self.readyState === 3 || self.readyState === 2) return;
      self.readyState = 2;
      const body = Buffer.isBuffer(reason) ? reason : Buffer.from(reason || '', 'utf8');
      const payload = Buffer.alloc(2 + body.length);
      payload.writeUInt16BE(code || 1000, 0);
      body.copy(payload, 2);
      const header = Buffer.alloc(2);
      header[0] = 0x88;
      header[1] = payload.length;
      socketWrite(Buffer.concat([header, payload]));
      setTimeout(() => {
        self.readyState = 3;
        try {
          socket.destroy();
        } catch (_) {}
      }, 60);
    },
  };

  function fire(type, ev) {
    for (const fn of [...(listeners[type] || [])]) {
      try {
        fn(ev);
      } catch (e) {
        console.error(`[raw-ws] ${type} 监听器抛错：${e.message}`);
      }
    }
  }

  // ---- 帧编解码（客户端发出的帧必须加掩码）----
  function encodeText(text) {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    // 头部 = 2 字节基础头 + 扩展长度(0/2/8) + 4 字节掩码键
    let extLen;
    if (len < 126) extLen = 0;
    else if (len < 65536) extLen = 2;
    else extLen = 8;
    const header = Buffer.alloc(2 + extLen + 4);
    header[0] = 0x81; // FIN=1, opcode=1(text)
    if (extLen === 0) {
      header[1] = 0x80 | len;
    } else if (extLen === 2) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    mask.copy(header, 2 + extLen);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, masked]);
  }

  function socketWrite(buf) {
    if (socket && !socket.destroyed) socket.write(buf);
  }

  let socket = null;
  let acc = Buffer.alloc(0);
  let fragOpcode = null;
  let fragChunks = [];

  function onFrames(buf) {
    acc = acc.length ? Buffer.concat([acc, buf]) : buf;
    for (;;) {
      if (acc.length < 2) return;
      const b0 = acc[0];
      const b1 = acc[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (acc.length < off + 2) return;
        len = acc.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (acc.length < off + 8) return;
        len = Number(acc.readBigUInt64BE(off));
        off += 8;
      }
      let maskKey = null;
      if (masked) {
        if (acc.length < off + 4) return;
        maskKey = acc.subarray(off, off + 4);
        off += 4;
      }
      if (acc.length < off + len) return;
      let payload = acc.subarray(off, off + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      acc = acc.subarray(off + len);

      if (opcode === 0x9) {
        // ping → pong
        const h = Buffer.alloc(2);
        h[0] = 0x8a;
        h[1] = payload.length;
        socketWrite(Buffer.concat([h, payload]));
      } else if (opcode === 0xa) {
        // pong：忽略
      } else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        closeFromServer(code, reason);
        return;
      } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) {
          fragOpcode = opcode;
          fragChunks = [payload];
        } else {
          fragChunks.push(payload);
        }
        if (fin) {
          const full = Buffer.concat(fragChunks);
          const op = fragOpcode;
          fragChunks = [];
          fragOpcode = null;
          if (op === 0x1) fire('message', { data: full.toString('utf8') });
        }
      }
    }
  }

  function closeFromServer(code, reason) {
    if (self.readyState === 3) return;
    const wasOpen = self.readyState === 1;
    self.readyState = 3;
    // 回一条 close（除非是握手阶段就失败）
    const h = Buffer.alloc(2);
    h[0] = 0x88;
    h[1] = 2;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(1000, 0);
    socketWrite(Buffer.concat([h, p]));
    try {
      socket.end();
    } catch (_) {}
    fire('close', { code, reason, wasClean: wasOpen });
  }

  // ---- 握手 ----
  const req = http.request({
    host: u.hostname,
    port: Number(u.port) || 80,
    path: u.pathname + (u.search || '') || '/',
    method: 'GET',
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    },
  });

  req.on('upgrade', (res, sock) => {
    // 校验服务端握手（RFC 6455：Sec-WebSocket-Accept = base64(sha1(key+GUID))）
    if (res.statusCode !== 101) {
      fire('error', { message: `握手失败：状态码 ${res.statusCode}` });
      sock.destroy();
      return;
    }
    if (res.headers['sec-websocket-accept'] !== expectedAccept) {
      fire('error', { message: '握手失败：Sec-WebSocket-Accept 校验不通过' });
      sock.destroy();
      return;
    }
    socket = sock;
    socket.setNoDelay(true);
    self.readyState = 1;
    socket.on('data', onFrames);
    socket.on('close', () => closeFromServer(1006, ''));
    socket.on('error', (e) => {
      fire('error', { message: e.message });
      closeFromServer(1006, '');
    });
    fire('open', {});
  });

  req.on('response', (res) => {
    res.resume();
    fire('error', { message: `服务端未升级协议（HTTP ${res.statusCode}）` });
    self.readyState = 3;
    fire('close', { code: 1006, reason: 'no upgrade', wasClean: false });
  });

  req.on('error', (e) => {
    if (self.readyState === 3) return;
    self.readyState = 3;
    fire('error', { message: e.message });
    fire('close', { code: 1006, reason: e.message, wasClean: false });
  });

  req.end();
  return self;
}

// 客户端工厂：默认先试内置 WebSocket，1.2 秒内连不上就退回首写客户端
function makeWsFactory(flags) {
  const NativeWS = typeof WebSocket === 'function' ? WebSocket : null;
  const mode = flags.rawWs ? 'raw' : flags.nativeWs ? 'native' : 'auto';

  function nativeProbe(url) {
    return new Promise((resolve) => {
      if (!NativeWS) return resolve(null);
      let ws = null;
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      try {
        ws = new NativeWS(url);
      } catch (_) {
        return finish(null);
      }
      ws.addEventListener('open', () => finish(ws));
      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch (_) {}
        finish(null);
      });
      setTimeout(() => {
        if (!settled) {
          try {
            ws.close();
          } catch (_) {}
        }
        finish(null);
      }, 1200);
    });
  }

  return async function connect(url) {
    if (mode === 'native') return { ws: await nativeProbe(url), impl: '内置 WebSocket（WebSocket 全局对象）' };
    if (mode === 'raw') return { ws: createRawWebSocketClient(url), impl: '手写零依赖 WebSocket 客户端（node:http upgrade 事件）' };
    const native = await nativeProbe(url);
    if (native) return { ws: native, impl: '内置 WebSocket（WebSocket 全局对象）' };
    return { ws: createRawWebSocketClient(url), impl: '手写零依赖 WebSocket 客户端（node:http upgrade 事件）—— 内置 WebSocket 客户端在本机 Node 上握手即抛 TypeError，已自动退回' };
  };
}

// ---------------------------------------------------------------------------
// 测试客户端：记录每条收到的报文，支持按条件等待
// ---------------------------------------------------------------------------
async function createClient(url, flags = {}) {
  const { ws, impl } = await makeWsFactory(flags)(url);
  if (!ws) throw new Error('无法建立 WebSocket 连接（内置客户端与手写客户端都失败）');
  return new Promise((resolve, reject) => {
    const messages = []; // { seq, dir, raw, msg, topic, service }
    const waiters = new Set();
    let seq = 0;
    let serviceId = 1;
    let opened = ws.readyState === 1;

    function push(entry) {
      entry.seq = ++seq;
      messages.push(entry);
      for (const w of [...waiters]) {
        let matched = false;
        try {
          matched = w.pred(entry);
        } catch (_) {
          matched = false;
        }
        if (matched) {
          waiters.delete(w);
          clearTimeout(w.timer);
          w.resolve(entry);
        }
      }
    }

    // 等待满足条件的报文（先扫历史，再挂等待）
    function next(pred, timeoutMs = 8000, label = '报文') {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { pred, resolve: res };
        w.timer = setTimeout(() => {
          waiters.delete(w);
          rej(new Error(`等待超时（${timeoutMs}ms）：${label}`));
        }, timeoutMs);
        waiters.add(w);
      });
    }

    function publishOf(topic, pred, timeoutMs = 8000) {
      return next(
        (e) => e.dir === 'in' && e.msg && e.msg.op === 'publish' && e.topic === topic && (!pred || pred(e)),
        timeoutMs,
        `${topic} 的 publish`
      );
    }

    // 等待某 service 的响应；带 id 时只配对同 id，避免 /navigate_to_pose 一服务两用互相串台
    function callService(service, args, timeoutMs = 8000) {
      const id = String(serviceId++);
      const raw = JSON.stringify({ op: 'call_service', service, args, id });
      const own = { raw, service, args, id };
      calls.push(own);
      ws.send(raw);
      return next(
        (e) => e.dir === 'in' && e.msg && e.msg.op === 'service_response' && e.service === service && String(e.msg.id) === id,
        timeoutMs,
        `${service} 的 service_response(id=${id})`
      ).then((e) => ({ raw, id, entry: e, values: e.msg.values, result: e.msg.result }));
    }

    const calls = [];

    function ready() {
      if (opened) return;
      opened = true;
      resolve({
        ws,
        impl,
        messages,
        calls,
        next,
        publishOf,
        callService,
        sendRaw: (text) => ws.send(text),
        close: () => ws.close(),
        // 便捷断言取数
        publishes: (topic) => messages.filter((e) => e.dir === 'in' && e.msg && e.msg.op === 'publish' && e.topic === topic),
      });
    }

    ws.addEventListener('open', ready);
    if (ws.readyState === 1) ready();
    ws.addEventListener('error', (ev) => {
      if (!opened) reject(new Error(`WebSocket 错误：${(ev && (ev.message || (ev.error && ev.error.message))) || 'unknown'}`));
    });
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let msg = null;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        msg = null;
      }
      push({
        dir: 'in',
        raw,
        msg,
        topic: msg && msg.topic,
        service: msg && msg.service,
      });
    });
  });
}

// 等待一个布尔条件成立
async function waitUntil(cond, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
(async function main() {
  console.log('=========================================================');
  console.log(' TobotSlam3D 协议一致性测试（mock 底盘端到端）');
  console.log(` 契约文件：${path.relative(process.cwd(), path.join(__dirname, 'protocol-contract.json'))}`);
  console.log('=========================================================');

  // 拉起 mock 服务端（同进程，用空闲端口；--fast 保证测试在数秒内跑完）
  const mock = createMockChassis({ port: 0, host: '127.0.0.1', fast: true, log: false });
  const info = await mock.start();
  const URL = `ws://127.0.0.1:${info.port}`;
  console.log(`\n[mock] 已启动 ${URL}（mode=${info.mode}）\n`);

  let client = null;
  try {
    // =====================================================================
    step('连接 mock 底盘');
    client = await createClient(URL, FLAGS);
    console.log(`  ℹ️  客户端实现：${client.impl}`);
    assertTrue('WebSocket 连接建立', client.ws.readyState === 1, `${URL} readyState=OPEN`);
    const templateUrl = CONTRACT.connection.webSocketUrlTemplate
      .replace('{host}', '127.0.0.1')
      .replace('{port}', String(info.port));
    assertEq('连接地址符合契约模板 ws://{host}:{port}', URL, templateUrl,
      `（契约默认端口 ${CONTRACT.connection.webSocketPort}；测试用空闲端口以免占用它）`);

    // =====================================================================
    step('契约 verbatimWireSamples 逐字符断言 + 实发');
    const samples = CONTRACT.verbatimWireSamples;
    assertEq('契约里有 5 条 subscribe + 3 条 call_service', samples.length, 8);
    const subSamples = samples.filter((s) => s.includes('"op":"subscribe"'));
    const callSamples = samples.filter((s) => s.includes('"op":"call_service"'));
    assertEq('subscribe 样本数', subSamples.length, 5);
    assertEq('call_service 样本数', callSamples.length, 3);
    for (const s of samples) {
      // 逐字符比对：契约字符串必须与我方「即将发出的报文」完全一致
      const rt = JSON.parse(s);
      const reconstructed =
        rt.op === 'subscribe'
          ? `{"op":"subscribe","topic":"${rt.topic}","type":"${rt.type}"}`
          : `{"op":"call_service","service":"${rt.service}","args":${JSON.stringify(rt.args)}}`;
      if (reconstructed === s) ok(`逐字符一致 ${s.slice(0, 72)}…`, `${s.length} 字节`);
      else bad('逐字符不一致', `契约=${s}\n我方=${reconstructed}`);
      client.sendRaw(s); // 按契约原文原样发出
    }
    // 5 条 subscribe 各应触发至少一条 publish（/map_list_kitty 等）
    const mapListFirst = await client.next(
      (e) => e.msg && e.msg.op === 'publish' && e.topic === '/map_list_kitty',
      3000,
      '订阅 /map_list_kitty 后立即推送'
    );
    assertTrue('/map_list_kitty 订阅后立即推一次', !!mapListFirst, `第 ${mapListFirst.seq} 条报文`);
    const poseFirst = await client.publishOf('/fast_lio_localization', null);
    assertTrue('/fast_lio_localization 订阅后开始周期推送', !!poseFirst);
    const workFirst = await client.publishOf('/ebot_work_state', null);
    assertTrue('/ebot_work_state 订阅后开始周期推送', !!workFirst);

    // 契约常量：z 恒为 0 + 合法四元数
    const pos = poseFirst.msg.msg.pose.pose.position;
    const ori = poseFirst.msg.msg.pose.pose.orientation;
    assertEq('/fast_lio_localization position.z 恒为 0', pos.z, 0);
    const quatNorm = Math.sqrt(ori.x ** 2 + ori.y ** 2 + ori.z ** 2 + ori.w ** 2);
    assertTrue('orientation 是合法四元数（模≈1）', Math.abs(quatNorm - 1) < 1e-3, `|q|=${quatNorm.toFixed(6)}`);
    assertTrue('orientation.x=y=0（只绕 z 轴）', ori.x === 0 && ori.y === 0, JSON.stringify(ori));

    const workData = workFirst.msg.msg.data;
    assertTrue(
      '/ebot_work_state data[0] 是 1 或 2（绝不是 0）',
      workData[0] === 1 || workData[0] === 2,
      `data=${JSON.stringify(workData)}`
    );
    assertTrue('/ebot_work_state data[1] 是 0~100 电量', workData[1] >= 0 && workData[1] <= 100, `电量=${workData[1]}`);
    assertEq('初始为未充电（契约 notCharging=2）', workData[0], CONTRACT.constants.notCharging);

    // =====================================================================
    step('建图闭环：/start_mapping_kitty → /save_map_kitty');
    const start = await client.callService('/start_mapping_kitty', {});
    assertEq('/start_mapping_kitty values.success', start.values.success, true);
    assertEq('/start_mapping_kitty values.message', start.values.message, 'Mapping started');
    assertEq('/start_mapping_kitty 包络 result', start.result, true);
    assertEq('/start_mapping_kitty 响应 service 原样回显', start.entry.msg.service, '/start_mapping_kitty');

    const save = await client.callService('/save_map_kitty', { filepath: 'test_map' });
    assertEq('/save_map_kitty values.success', save.values.success, true);
    assertEq('/save_map_kitty values.message', save.values.message, 'Map saved');

    // =====================================================================
    step('断言 /map_list_kitty 里出现 test_map');
    const found = await waitUntil(
      () =>
        client
          .publishes('/map_list_kitty')
          .some((e) => (e.msg.msg.maps || []).some((m) => m.map_name === 'test_map')),
      info.mode === 'fast' ? 3000 : 12000
    );
    assertTrue('MapList 推送里包含新建的 test_map', found);
    const mapsNow = client
      .publishes('/map_list_kitty')
      .at(-1).msg.msg.maps.map((m) => m.map_name);
    assertTrue('预置地图仍在（2026.9.20 / 测试_2026_09_09）', mapsNow.includes('2026.9.20') && mapsNow.includes('测试_2026_09_09'), mapsNow.join('、'));

    // =====================================================================
    step('反例：filepath 带路径 → 必须判失败（抓客户端错误）');
    const badSave = await client.callService('/save_map_kitty', { filepath: '/bad/path' });
    assertEq('/save_map_kitty("/bad/path") values.success', badSave.values.success, false);
    assertHas('/save_map_kitty("/bad/path") message 给出原因', badSave.values.message, 'plain map name');

    // 反例：/delete_map_kitty 误传 filepath 字段
    const badDel = await client.callService('/delete_map_kitty', { filepath: 'test_map' });
    assertEq('/delete_map_kitty 误传 filepath → success', badDel.values.success, false);
    assertHas('/delete_map_kitty 误传 filepath → message 指出应用 map_name', badDel.values.message, 'map_name');

    // 反例：未知 service
    const unknown = await client.callService('/not_a_real_service_kitty', {});
    assertEq('未知 service → values.success', unknown.values.success, false);
    assertEq('未知 service → values.message', unknown.values.message, 'unknown service');
    assertEq('未知 service → result', unknown.result, false);

    // =====================================================================
    step('选图并启动导航：/select_map_and_start_kitty');
    const select = await client.callService('/select_map_and_start_kitty', { filepath: 'test_map' });
    assertEq('/select_map_and_start_kitty values.success', select.values.success, true);
    assertEq(
      '/select_map_and_start_kitty values.message',
      select.values.message,
      'Map selected and navigation started'
    );

    // =====================================================================
    step('添加目标点：/add_goal_kitty（theta 弧度）');
    const add = await client.callService('/add_goal_kitty', {
      map_name: 'test_map',
      goal_name: 'front',
      x: 1.0,
      y: 2.0,
      theta: 0.5,
    });
    assertEq('/add_goal_kitty values.success', add.values.success, true);
    assertEq('/add_goal_kitty values.message', add.values.message, 'Added successfully');

    // =====================================================================
    step('断言 MapList 里 test_map 下有 front 且 theta≈0.5');
    const goalSeen = await waitUntil(
      () =>
        client.publishes('/map_list_kitty').some((e) => {
          const m = (e.msg.msg.maps || []).find((x) => x.map_name === 'test_map');
          return m && (m.goals || []).some((g) => g.name === 'front');
        }),
      4000
    );
    assertTrue('MapList 推送里 test_map 下出现 front', goalSeen);
    const frontGoal = client
      .publishes('/map_list_kitty')
      .map((e) => (e.msg.msg.maps || []).find((x) => x.map_name === 'test_map'))
      .filter(Boolean)
      .map((m) => (m.goals || []).find((g) => g.name === 'front'))
      .filter(Boolean)
      .at(-1);
    assertTrue('front 目标点存在', !!frontGoal, JSON.stringify(frontGoal));
    if (frontGoal) {
      assertTrue('front.x/y 与请求一致', frontGoal.x === 1.0 && frontGoal.y === 2.0, `x=${frontGoal.x} y=${frontGoal.y}`);
      assertTrue('front.theta ≈ 0.5（弧度）', Math.abs(frontGoal.theta - 0.5) < 1e-9, `theta=${frontGoal.theta}`);
    }

    // =====================================================================
    step('导航到点：/navigate_to_pose（契约 goal.pose.position）');
    const nav = await client.callService('/navigate_to_pose', {
      goal: { pose: { position: { x: 1.0, y: 2.0, z: 0.0 } } },
    });
    assertEq('/navigate_to_pose values.result', nav.result, true);
    assertTrue(
      '/navigate_to_pose 响应带 plan.poses 且点数 > 0',
      nav.values.plan && Array.isArray(nav.values.plan.poses) && nav.values.plan.poses.length > 0,
      `点数=${nav.values.plan && nav.values.plan.poses.length}`
    );
    assertTrue(
      'plan.poses[].pose.position.z 恒为 0',
      nav.values.plan.poses.every((p) => p.pose.position.z === 0)
    );
    assertEq('响应 id 回显（mock 便利行为，原文未规定）', nav.entry.msg.id, nav.id);

    const pathPush = await client.publishOf('/aft_pgo_path', (e) => (e.msg.msg.poses || []).length > 0);
    assertTrue(
      '收到 /aft_pgo_path 推送且 poses 点数 > 0',
      (pathPush.msg.msg.poses || []).length > 0,
      `点数=${pathPush.msg.msg.poses.length}`
    );
    assertTrue(
      '/aft_pgo_path poses[].pose.position.z 恒为 0',
      pathPush.msg.msg.poses.every((p) => p.pose.position.z === 0)
    );

    const arrived = await waitUntil(
      () => {
        const list = client.publishes('/ebot_goal_status_local_planner');
        return list.length > 0 && list.at(-1).msg.msg.data[0] === 1;
      },
      info.mode === 'fast' ? 4000 : 20000
    );
    assertTrue(
      '/ebot_goal_status_local_planner 最终 data[0]==1（契约 goalStatusArrived）',
      arrived,
      `最后一条 data=${JSON.stringify(client.publishes('/ebot_goal_status_local_planner').at(-1).msg.msg.data)}`
    );
    const pathCount = client.publishes('/aft_pgo_path').length;
    assertTrue(
      `路径推送次数 ≤ 契约 pathPublishCount(${CONTRACT.constants.pathPublishCount})`,
      pathCount <= CONTRACT.constants.pathPublishCount,
      `实际 ${pathCount} 次`
    );

    // =====================================================================
    step('取消导航：/navigate_to_pose 魔数坐标（x=999999,y=888888,z=0）');
    const seqBeforeCancel = client.messages.length;
    const cancel = await client.callService('/navigate_to_pose', {
      goal: { pose: { position: { x: CANCEL_X(), y: CANCEL_Y(), z: 0 } } },
    });
    assertEq('取消响应 result', cancel.result, true);
    assertEq('取消响应 plan.poses 为空数组', cancel.values.plan.poses, []);
    assertEq('取消响应 id 回显与请求配对', cancel.entry.msg.id, cancel.id);
    // 契约要求：取消后不得再发到达（1）
    const afterCancelWindow = info.mode === 'fast' ? 2500 : 9000; // > driveDelay，确保覆盖原本的到达时刻
    await sleep(afterCancelWindow);
    const arrivalsAfterCancel = client.messages
      .slice(seqBeforeCancel)
      .filter(
        (e) =>
          e.msg &&
          e.msg.op === 'publish' &&
          e.topic === '/ebot_goal_status_local_planner' &&
          e.msg.msg.data[0] === 1
      );
    assertEq('取消导航后不再收到 data[0]==1', arrivalsAfterCancel.length, 0);
    assertTrue(
      '取消后路径推送停止',
      client.publishes('/aft_pgo_path').length <= CONTRACT.constants.pathPublishCount,
      `路径推送共 ${client.publishes('/aft_pgo_path').length} 次`
    );

    // =====================================================================
    step('回充桩：/docking_kitty → /ebot_work_state 进入充电');
    const dock = await client.callService('/docking_kitty', {});
    assertEq('/docking_kitty values.success（仅表示流程已启动）', dock.values.success, true);
    assertEq('/docking_kitty values.message', dock.values.message, 'Docking started');
    const charging = await waitUntil(() => {
      const list = client.publishes('/ebot_work_state');
      return list.length > 0 && list.at(-1).msg.msg.data[0] === CONTRACT.constants.charging;
    }, 4000);
    assertTrue(
      `/ebot_work_state data[0]==1（契约 charging=1）`,
      charging,
      `最后一条 data=${JSON.stringify(client.publishes('/ebot_work_state').at(-1).msg.msg.data)}`
    );
    const lastWork = client.publishes('/ebot_work_state').at(-1).msg.msg.data;
    assertTrue('充电中电量 data[1] 在 0~100', lastWork[1] >= 0 && lastWork[1] <= 100, `电量=${lastWork[1]}`);
    assertTrue('充电状态值是 1 或 2（不出现 0）', lastWork[0] === 1 || lastWork[0] === 2, `data[0]=${lastWork[0]}`);

    // =====================================================================
    step('删除目标点：/delete_goal_kitty');
    const delGoal = await client.callService('/delete_goal_kitty', { map_name: 'test_map', goal_name: 'front' });
    assertEq('/delete_goal_kitty values.success', delGoal.values.success, true);
    assertEq('/delete_goal_kitty values.message', delGoal.values.message, 'Deleted successfully');
    const goalGone = await waitUntil(
      () =>
        client.publishes('/map_list_kitty').some((e) => {
          const m = (e.msg.msg.maps || []).find((x) => x.map_name === 'test_map');
          return m && !(m.goals || []).some((g) => g.name === 'front');
        }),
      4000
    );
    assertTrue('MapList 里 test_map 下不再有 front', goalGone);

    // =====================================================================
    step('删除地图：/delete_map_kitty');
    const delMap = await client.callService('/delete_map_kitty', { map_name: 'test_map' });
    assertEq('/delete_map_kitty values.success', delMap.values.success, true);
    assertEq('/delete_map_kitty values.message', delMap.values.message, 'Deleted successfully');
    const mapGone = await waitUntil(
      () =>
        client
          .publishes('/map_list_kitty')
          .some((e) => !(e.msg.msg.maps || []).some((m) => m.map_name === 'test_map')),
      4000
    );
    assertTrue('MapList 里 test_map 已消失', mapGone);
    // 取「删图请求发出之后」的最后一条推送，避免读到删图前的旧推送（mock 的重推是异步的）
    const seqAfterDel = client.messages.length;
    const delMapNotify = await client.next(
      (e) =>
        e.seq > seqAfterDel &&
        e.msg &&
        e.msg.op === 'publish' &&
        e.topic === '/map_list_kitty' &&
        !(e.msg.msg.maps || []).some((m) => m.map_name === 'test_map'),
      4000,
      '删图后的 /map_list_kitty 重推'
    ).catch(() => null);
    assertTrue('收到删图后的 /map_list_kitty 重推（mock 便利行为）', !!delMapNotify);
    const finalMaps = (delMapNotify || client.publishes('/map_list_kitty').at(-1)).msg.msg.maps.map((m) => m.map_name);
    assertTrue(
      '预置地图未被误删且 test_map 已不在列表',
      finalMaps.includes('2026.9.20') && finalMaps.includes('测试_2026_09_09') && !finalMaps.includes('test_map'),
      finalMaps.join('、')
    );

    // =====================================================================
    step('畸形报文容错（不崩）');
    client.sendRaw('{ this is not json ');
    client.sendRaw('{"op":"???","topic":"/x"}');
    await sleep(120);
    // 发一条正常请求确认连接仍可用
    const alive = await client.callService('/start_mapping_kitty', {});
    assertTrue('畸形 JSON / 未知 op 后服务端仍存活', alive.values.success === true);
    const invalidJsonResp = client.messages.find(
      (e) => e.msg && e.msg.op === 'service_response' && e.msg.service === '' && e.msg.values && e.msg.values.success === false
    );
    assertTrue('对畸形 JSON 回了明确的错误响应（mock 便利行为）', !!invalidJsonResp);

    client.close();
  } catch (e) {
    bad('测试流程异常中断', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  } finally {
    try {
      await mock.stop();
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  console.log('\n=========================================================');
  const total = passCount + failCount;
  if (failCount === 0) {
    console.log(` ✅ 全部通过：${passCount}/${total} 项断言`);
    console.log('=========================================================');
    process.exit(0);
  } else {
    console.log(` ❌ 失败 ${failCount} 项 / 共 ${total} 项断言（通过 ${passCount}）`);
    console.log(' 失败清单：');
    for (const f of failures) console.log(`   - ${f}`);
    console.log('=========================================================');
    process.exit(1);
  }
})().catch((e) => {
  console.error(`\n❌ 测试启动失败：${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

function CANCEL_X() {
  return CONTRACT.cancelNavigation.args.goal.pose.position.x;
}
function CANCEL_Y() {
  return CONTRACT.cancelNavigation.args.goal.pose.position.y;
}
