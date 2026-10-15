#!/usr/bin/env node
/*
 * TobotSlam3D 协议测试夹具 —— 模拟「3D 雷达导航底盘」的 rosbridge 服务端
 * ---------------------------------------------------------------------------
 * 零依赖：不使用 ws / socket.io 等任何 npm 包；WebSocket 服务端为手写实现
 * （node:http + 'upgrade' 事件，含 Sec-WebSocket-Accept 握手、文本帧解析/编码、
 *   126/127 两种扩展长度、掩码解码、close 帧、ping/pong）。
 *
 * 唯一事实来源：../protocol-contract.json（与 ../../tobot-sdk-protocol-spec.md 一致）
 *
 * 用法：
 *   node server.js                  # 监听 ws://127.0.0.1:9090
 *   node server.js --port 19090     # 自定义端口
 *   node server.js --fast           # 快速模式（路径推送 200ms x 5，到达判定提前）
 *   MOCK_FAST=1 node server.js      # 同上，环境变量方式
 *
 * 也可被 require：const { createMockChassis } = require('./server.js')
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

// rosbridge / WebSocket 握手固定 GUID（RFC 6455）
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11F';

// ---------------------------------------------------------------------------
// 1) 手写 WebSocket 帧编解码（服务端方向）
// ---------------------------------------------------------------------------

// 生成一帧文本帧（服务端发出的帧不加掩码）
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    // 扩展长度：16 位（126）
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    // 扩展长度：64 位（127）
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN=1, opcode=1(text)
  return Buffer.concat([header, payload]);
}

// 生成 close 帧（可带 2 字节状态码）
function encodeCloseFrame(code, reason) {
  let payload = Buffer.alloc(0);
  if (code) {
    const r = Buffer.from(reason || '', 'utf8');
    payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
  }
  const header = Buffer.alloc(2);
  header[0] = 0x88;
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

// 生成 pong 帧（原样回带 ping 的 payload）
function encodePongFrame(payload) {
  const p = payload || Buffer.alloc(0);
  const header = Buffer.alloc(2);
  header[0] = 0x8a;
  header[1] = p.length < 126 ? p.length : 126;
  if (p.length < 126) return Buffer.concat([header, p]);
  const h2 = Buffer.alloc(4);
  h2[0] = 0x8a;
  h2[1] = 126;
  h2.writeUInt16BE(p.length, 2);
  return Buffer.concat([h2, p]);
}

// 掩码解码（RFC 6455：payload[i] ^= mask[i % 4]）
function unmask(buf, mask) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ mask[i & 3];
  return out;
}

/**
 * 增量帧解析器：处理粘包 / 半包，返回本次解析出的完整帧数组。
 * 支持：文本帧、二进制帧、continuation 分片、close、ping、pong。
 * 返回的每帧形如 { fin, opcode, payload(Buffer，已解掩码) }
 */
function createFrameParser() {
  let acc = Buffer.alloc(0);

  function push(chunk) {
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    const frames = [];
    for (;;) {
      if (acc.length < 2) break;
      const b0 = acc[0];
      const b1 = acc[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (acc.length < offset + 2) break;
        len = acc.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (acc.length < offset + 8) break;
        const big = acc.readBigUInt64BE(offset);
        // 防御：超过 64MB 视为异常，交给上层断开
        len = Number(big);
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (acc.length < offset + 4) break;
        maskKey = acc.subarray(offset, offset + 4);
        offset += 4;
      }

      if (acc.length < offset + len) break;
      let payload = acc.subarray(offset, offset + len);
      if (masked) payload = unmask(payload, maskKey);
      else payload = Buffer.from(payload); // 复制，避免持有大缓冲

      acc = acc.subarray(offset + len);
      frames.push({ fin, opcode, payload });
    }
    return frames;
  }

  return { push };
}

// ---------------------------------------------------------------------------
// 2) 控制台报文日志（带方向前缀，便于联调）
// ---------------------------------------------------------------------------
function makeLogger(enableLog) {
  const stamp = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  return {
    info: (msg) => console.log(`[${stamp()}] [mock-chassis] ${msg}`),
    // → 表示发往客户端，← 表示收到客户端
    out: (label, obj) => {
      if (!enableLog) return;
      const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
      console.log(`[${stamp()}] → ${label} ${text}`);
    },
    in: (label, obj) => {
      if (!enableLog) return;
      const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
      console.log(`[${stamp()}] ← ${label} ${text}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 3) mock 底盘状态与业务逻辑
// ---------------------------------------------------------------------------

const TOPIC_TYPE = {
  '/fast_lio_localization': 'nav_msgs/Odometry',
  '/aft_pgo_path': 'nav_msgs/Path',
  '/map_list_kitty': 'kitty_runtime_manager/MapList',
  '/ebot_goal_status_local_planner': 'std_msgs/Float64MultiArray',
  '/ebot_work_state': 'std_msgs/Float64MultiArray',
};

const SERVICE_TYPE = {
  '/start_mapping_kitty': 'std_srvs/Trigger',
  '/save_map_kitty': 'kitty_runtime_manager/SaveMap',
  '/select_map_and_start_kitty': 'kitty_runtime_manager/SaveMap', // 原文即如此（与 save_map 同类型）
  '/delete_map_kitty': 'kitty_runtime_manager/DeleteMap',
  '/docking_kitty': 'std_srvs/Trigger',
  '/navigate_to_pose': 'nav_msgs/GetPlan',
  '/add_goal_kitty': 'kitty_runtime_manager/AddGoal',
  '/delete_goal_kitty': 'kitty_runtime_manager/DeleteGoal',
};

// 取消导航魔数坐标（契约 cancelNavigation）
const CANCEL_X = 999999;
const CANCEL_Y = 888888;

// 预置地图（模拟真实环境；契约 specGaps 说明原文未规定持久化行为）
function defaultMaps() {
  return [
    {
      map_name: '2026.9.20',
      map_path: '/maps/2026.9.20',
      goals: [
        { name: '1', x: 5.23, y: -0.2, theta: 0 },
        { name: '2', x: 6.58, y: -1.36, theta: 0 },
      ],
    },
    {
      map_name: '测试_2026_09_09',
      map_path: '/maps/测试_2026_09_09',
      goals: [],
    },
  ];
}

/**
 * 创建（但不启动）一个 mock 底盘实例。
 * @param {object} [opts]
 * @param {number} [opts.port=9090]  监听端口，0 = 由系统分配空闲端口
 * @param {string} [opts.host='127.0.0.1']
 * @param {boolean} [opts.fast=false] 快速模式
 * @param {boolean} [opts.log=true]   是否打印每条收发报文
 * @param {boolean} [opts.quiet=false] 是否隐藏启动横幅
 */
function createMockChassis(opts = {}) {
  const fast = !!(opts.fast || process.env.MOCK_FAST === '1');
  const logger = makeLogger(opts.log !== false);

  // 频率/时延参数（原文除 /aft_pgo_path 外均未规定 → 属 mock 便利选择，见 README）
  const T = fast
    ? { pose: 100, mapList: 1000, workState: 200, pathCount: 5, pathInterval: 200, driveDelay: 1500 }
    : { pose: 100, mapList: 5000, workState: 1000, pathCount: 5, pathInterval: 5000, driveDelay: 6000 };

  // ---- 底盘状态 -----------------------------------------------------------
  const state = {
    maps: defaultMaps(),
    currentMap: null,
    mapping: false,
    navActive: false,
    navStart: { x: 0, y: 0 },
    navGoal: null,
    poses: [], // 当前路径（取消后清空）
    pathTimer: null,
    pathSent: 0,
    arrivalTimer: null,
    charging: false,
    // 电量缓慢下降；充电后缓慢上升（原文未规定，mock 便利行为）
    battery: 87.5,
    poseT: 0,
    subscribers: new Map(), // topic -> Set<client>
    mapListTimer: null,
    sweepTimer: null, // 位姿推进
    workTimer: null,
    connSeq: 0,
  };

  const clients = new Set();

  // ---- 工具 ---------------------------------------------------------------
  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function findMap(name) {
    return state.maps.find((m) => m.map_name === name) || null;
  }

  function mapListMsg() {
    return { maps: clone(state.maps) };
  }

  // 按契约常量生成位姿：z 恒为 0，四元数只绕 z 轴
  function poseMsg() {
    const t = state.poseT;
    const x = Number((t * 0.05).toFixed(3)); // 沿 x 缓慢前进
    const y = Number((Math.sin(t / 12) * 0.4).toFixed(3));
    const yaw = Number((Math.sin(t / 18) * 0.6).toFixed(4)); // 合法 yaw
    return {
      pose: {
        pose: {
          position: { x, y, z: 0.0 }, // z 恒为 0（契约 constants.zAlwaysZero）
          orientation: {
            x: 0.0,
            y: 0.0,
            z: Number(Math.sin(yaw / 2).toFixed(6)),
            w: Number(Math.cos(yaw / 2).toFixed(6)),
          },
        },
      },
    };
  }

  function workStateMsg() {
    return {
      data: [
        state.charging ? 1 : 2, // 1=充电，2=未充电（绝不是 0）
        Number(state.battery.toFixed(1)), // 电量百分比
      ],
    };
  }

  // 由当前路径生成一条 nav_msgs/Path（poses[].pose.position.z 恒为 0）
  function pathMsg(progress) {
    const from = state.navStart;
    const to = state.navGoal || { x: 0, y: 0 };
    const steps = 8;
    const poses = [];
    for (let i = 0; i <= steps; i++) {
      const k = Math.min(1, progress + i / steps / Math.max(1, T.pathCount));
      poses.push({
        pose: {
          position: {
            x: Number((from.x + (to.x - from.x) * k).toFixed(3)),
            y: Number((from.y + (to.y - from.y) * k).toFixed(3)),
            z: 0.0,
          },
        },
      });
    }
    return { poses };
  }

  // ---- 发送 ---------------------------------------------------------------
  function send(client, obj, label) {
    const text = JSON.stringify(obj);
    logger.out(label || (obj.op === 'publish' ? `publish ${obj.topic}` : obj.op || 'frame'), text);
    if (client.socket.destroyed || !client.socket.writable) return;
    client.socket.write(encodeTextFrame(text));
  }

  function publish(client, topic, msg) {
    send(client, { op: 'publish', topic, msg }, `publish ${topic}`);
  }

  function publishToSubscribers(topic, msg, label) {
    const subs = state.subscribers.get(topic);
    if (!subs || subs.size === 0) return;
    for (const c of subs) publish(c, topic, msg);
    if (label) logger.info(label);
  }

  // ---- Service 响应 -------------------------------------------------------
  // 契约包络：{"op":"service_response","service":"<原样>","values":{...},"result":true}
  // id 回显为 mock 便利行为（原文未规定，契约 specGaps 已注明）
  function respond(client, service, values, result, id) {
    const envelope = { op: 'service_response', service, values, result };
    if (id !== undefined && id !== null) envelope.id = id;
    send(client, envelope, `service_response ${service}`);
  }

  function respondOk(client, service, values, id) {
    respond(client, service, values, true, id);
  }

  function respondErr(client, service, values, id) {
    respond(client, service, values, false, id);
  }

  // ---- 路径推送（仅导航启动后；约 5s x 5 次；取消后立即停止） --------------
  function stopPathPush() {
    if (state.pathTimer) {
      clearInterval(state.pathTimer);
      state.pathTimer = null;
    }
  }

  function startPathPush() {
    stopPathPush();
    state.pathSent = 0;
    state.pathTimer = setInterval(() => {
      if (!state.navActive || state.pathSent >= T.pathCount) {
        stopPathPush();
        return;
      }
      const msg = pathMsg(state.pathSent / Math.max(1, T.pathCount));
      state.poses = msg.poses;
      state.pathSent += 1;
      publishToSubscribers('/aft_pgo_path', msg);
      logger.info(`/aft_pgo_path 第 ${state.pathSent}/${T.pathCount} 次推送`);
      if (state.pathSent >= T.pathCount) stopPathPush();
    }, T.pathInterval);
  }

  function stopArrival() {
    if (state.arrivalTimer) {
      clearTimeout(state.arrivalTimer);
      state.arrivalTimer = null;
    }
  }

  // 模拟行驶：先发 data[0]=0，行驶一段时间后发 data[0]=1
  function startDriving() {
    stopArrival();
    publishToSubscribers('/ebot_goal_status_local_planner', { data: [0] }); // 0 = 未到达
    state.arrivalTimer = setTimeout(() => {
      state.arrivalTimer = null;
      if (!state.navActive) return; // 已取消 → 绝不再发 1
      publishToSubscribers('/ebot_goal_status_local_planner', { data: [1] }); // 1 = 到达
      logger.info('导航模拟行驶结束，已推送 data[0]=1（到达）');
    }, T.driveDelay);
  }

  function startNavigation(goal) {
    state.navActive = true;
    state.navGoal = { x: goal.x, y: goal.y };
    const here = poseMsg().pose.pose.position;
    state.navStart = { x: here.x, y: here.y };
    startPathPush();
    startDriving();
  }

  // 取消导航：停止导航、清空路径、不再发到达
  function cancelNavigation() {
    state.navActive = false;
    state.navGoal = null;
    state.poses = [];
    stopPathPush();
    stopArrival();
    logger.info('已取消导航：停止路径推送与到达判定（data[0] 不会被置 1）');
  }

  // ---- 8 个服务（9 项功能） ----------------------------------------------
  function handleService(client, service, args, id) {
    const a = args && typeof args === 'object' ? args : {};

    switch (service) {
      // 4.1 开始建图（std_srvs/Trigger，空请求）
      case '/start_mapping_kitty': {
        state.mapping = true;
        return respondOk(client, service, { success: true, message: 'Mapping started' }, id);
      }

      // 4.2 保存地图（filepath 只传地图名，不带路径）
      case '/save_map_kitty': {
        const filepath = a.filepath;
        if (typeof filepath !== 'string' || filepath.trim() === '') {
          return respondErr(
            client,
            service,
            { success: false, message: 'save failed: missing "filepath" (expected plain map name)' },
            id
          );
        }
        if (filepath.includes('/') || filepath.includes('\\')) {
          // mock 的抓错行为：把路径当地图名传 → 判失败（原文只说「不要带路径」）
          return respondErr(
            client,
            service,
            {
              success: false,
              message: `save failed: filepath must be a plain map name without path separators, got "${filepath}"`,
            },
            id
          );
        }
        if (findMap(filepath)) {
          return respondErr(client, service, { success: false, message: `map "${filepath}" already exists` }, id);
        }
        state.maps.push({ map_name: filepath, map_path: `/maps/${filepath}`, goals: [] });
        logger.info(`已保存地图 "${filepath}"`);
        respondOk(client, service, { success: true, message: 'Map saved' }, id);
        // mock 便利行为：增删改后重新推送 /map_list_kitty（原文未说明）
        scheduleMapListPush();
        return;
      }

      // 4.3 选择地图并启动导航（类型原文写作 kitty_runtime_manager/SaveMap）
      case '/select_map_and_start_kitty': {
        const filepath = a.filepath;
        if (typeof filepath !== 'string' || filepath.trim() === '') {
          return respondErr(
            client,
            service,
            { success: false, message: 'select failed: missing "filepath" (expected plain map name)' },
            id
          );
        }
        if (filepath.includes('/') || filepath.includes('\\')) {
          return respondErr(
            client,
            service,
            { success: false, message: `select failed: filepath must be a plain map name, got "${filepath}"` },
            id
          );
        }
        const m = findMap(filepath);
        if (!m) {
          return respondErr(client, service, { success: false, message: `map "${filepath}" not found` }, id);
        }
        state.currentMap = filepath;
        logger.info(`已选图 "${filepath}"，进入导航模式`);
        respondOk(client, service, { success: true, message: 'Map selected and navigation started' }, id);
        scheduleMapListPush(); // mock 便利行为
        return;
      }

      // 4.4 删除地图（字段是 map_name，不是 filepath）
      case '/delete_map_kitty': {
        if (Object.prototype.hasOwnProperty.call(a, 'filepath') && !Object.prototype.hasOwnProperty.call(a, 'map_name')) {
          // mock 的抓错行为：误传 filepath → 判失败（原文强调字段不可互换）
          return respondErr(
            client,
            service,
            { success: false, message: 'delete failed: this service takes "map_name", not "filepath"' },
            id
          );
        }
        const name = a.map_name;
        if (typeof name !== 'string' || name.trim() === '') {
          return respondErr(client, service, { success: false, message: 'delete failed: missing "map_name"' }, id);
        }
        const idx = state.maps.findIndex((m) => m.map_name === name);
        if (idx < 0) {
          return respondErr(client, service, { success: false, message: `map "${name}" not found` }, id);
        }
        state.maps.splice(idx, 1);
        if (state.currentMap === name) state.currentMap = null;
        logger.info(`已删除地图 "${name}"`);
        // 契约里该服务的响应文案为 "Deleted successfully"
        respondOk(client, service, { success: true, message: 'Deleted successfully' }, id);
        scheduleMapListPush(); // mock 便利行为
        return;
      }

      // 4.5 回充电桩（success 只表示流程已启动）
      case '/docking_kitty': {
        logger.info('收到回充指令：流程已启动');
        respondOk(client, service, { success: true, message: 'Docking started' }, id);
        // mock 便利行为：随后进入充电状态（/ebot_work_state data[0] 变 1）
        setTimeout(() => {
          state.charging = true;
          publishToSubscribers('/ebot_work_state', workStateMsg());
          logger.info('已进入充电状态（/ebot_work_state data[0]=1）');
        }, fast ? 100 : 500);
        return;
      }

      // 4.6 / 4.7 导航到点 + 取消导航（同一服务，靠魔数坐标区分）
      case '/navigate_to_pose': {
        const pos = a && a.goal && a.goal.pose && a.goal.pose.position ? a.goal.pose.position : null;
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
          return respondErr(
            client,
            service,
            { plan: { poses: [] }, success: false, message: 'navigate failed: missing goal.pose.position.x/y' },
            id
          );
        }
        const isCancel = pos.x === CANCEL_X && pos.y === CANCEL_Y;
        if (isCancel) {
          cancelNavigation();
          return respondOk(client, service, { plan: { poses: [] } }, id);
        }
        startNavigation(pos);
        logger.info(`开始导航到 (${pos.x}, ${pos.y})`);
        // 响应里的 plan.poses 与 /aft_pgo_path 结构一致（PoseStamped 数组，z 恒 0）
        return respondOk(client, service, { plan: pathMsg(0) }, id);
      }

      // 4.8 添加目标点（theta 单位弧度）
      case '/add_goal_kitty': {
        const mapName = a.map_name;
        const goalName = a.goal_name;
        if (typeof mapName !== 'string' || typeof goalName !== 'string') {
          return respondErr(
            client,
            service,
            { success: false, message: 'add failed: requires "map_name" and "goal_name"' },
            id
          );
        }
        let m = findMap(mapName);
        if (!m) {
          // mock 便利行为：目标点所属地图不存在时自动建一张空地图
          m = { map_name: mapName, map_path: `/maps/${mapName}`, goals: [] };
          state.maps.push(m);
        }
        m.goals = m.goals.filter((g) => g.name !== goalName);
        m.goals.push({
          name: goalName,
          x: Number(a.x) || 0,
          y: Number(a.y) || 0,
          theta: Number(a.theta) || 0,
        });
        logger.info(`地图 "${mapName}" 新增目标点 "${goalName}"`);
        respondOk(client, service, { success: true, message: 'Added successfully' }, id);
        scheduleMapListPush(); // mock 便利行为
        return;
      }

      // 4.9 删除目标点
      case '/delete_goal_kitty': {
        const mapName = a.map_name;
        const goalName = a.goal_name;
        if (typeof mapName !== 'string' || typeof goalName !== 'string') {
          return respondErr(
            client,
            service,
            { success: false, message: 'delete failed: requires "map_name" and "goal_name"' },
            id
          );
        }
        const m = findMap(mapName);
        if (!m) {
          return respondErr(client, service, { success: false, message: `map "${mapName}" not found` }, id);
        }
        const before = m.goals.length;
        m.goals = m.goals.filter((g) => g.name !== goalName);
        if (m.goals.length === before) {
          return respondErr(client, service, { success: false, message: `goal "${goalName}" not found` }, id);
        }
        logger.info(`地图 "${mapName}" 删除目标点 "${goalName}"`);
        respondOk(client, service, { success: true, message: 'Deleted successfully' }, id);
        scheduleMapListPush(); // mock 便利行为
        return;
      }

      // 未知 service → result:false
      default: {
        logger.info(`未知 service：${service}`);
        return respondErr(client, service, { success: false, message: 'unknown service' }, id);
      }
    }
  }

  // ---- 报文入口 -----------------------------------------------------------
  function handleText(client, text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch (e) {
      // 畸形 JSON 不崩，回一条明确的错误（原文未规定错误包络，属 mock 便利行为）
      logger.in('malformed', text);
      logger.info(`收到畸形 JSON，已忽略：${e.message}`);
      send(
        client,
        { op: 'service_response', service: '', values: { success: false, message: `invalid JSON: ${e.message}` }, result: false },
        'service_response <invalid>'
      );
      return;
    }
    if (!m || typeof m !== 'object') {
      logger.info('收到非对象 JSON，已忽略');
      return;
    }

    const id = m.id; // 原文未规定；有则回显

    switch (m.op) {
      case 'subscribe': {
        const topic = m.topic;
        const type = m.type;
        if (!state.subscribers.has(topic)) state.subscribers.set(topic, new Set());
        state.subscribers.get(topic).add(client);
        client.topics.add(topic);
        logger.info(`客户端 #${client.id} 订阅 ${topic} (${type})`);

        // 订阅后立即推送初始数据
        if (topic === '/fast_lio_localization') publish(client, topic, poseMsg());
        else if (topic === '/ebot_work_state') publish(client, topic, workStateMsg());
        else if (topic === '/map_list_kitty') {
          // 按原文：「订阅后返回所有地图及其已保存目标点」
          publish(client, topic, mapListMsg());
          ensureMapListPush();
        }
        // /aft_pgo_path 只在导航启动后推送；/ebot_goal_status_local_planner 按行程推送
        return;
      }

      case 'call_service': {
        handleService(client, m.service, m.args, id);
        return;
      }

      case 'publish': {
        // 底盘只作为服务端；客户端 publish 按原文规格无定义 → 只记日志
        logger.info(`收到客户端 publish（规格未定义，忽略）：${m.topic}`);
        return;
      }

      default: {
        if (m.op === undefined) {
          logger.info('报文缺少 op 字段，已忽略');
        } else {
          logger.info(`未知 op：${m.op}，已忽略`);
        }
        return;
      }
    }
  }

  // ---- 周期推送 -----------------------------------------------------------
  // mock 便利行为：/map_list_kitty 在订阅后与增删改后重复推送
  function ensureMapListPush() {
    if (state.mapListTimer) return;
    state.mapListTimer = setInterval(() => {
      const subs = state.subscribers.get('/map_list_kitty');
      if (!subs || subs.size === 0) {
        clearInterval(state.mapListTimer);
        state.mapListTimer = null;
        return;
      }
      publishToSubscribers('/map_list_kitty', mapListMsg());
    }, T.mapList);
    if (state.mapListTimer.unref) state.mapListTimer.unref();
  }

  function scheduleMapListPush() {
    // 让紧随其后的 /map_list_kitty 推送能反映最新状态
    setTimeout(() => {
      publishToSubscribers('/map_list_kitty', mapListMsg(), '增删改后重推 /map_list_kitty（mock 便利行为）');
      ensureMapListPush();
    }, 10);
  }

  function startSweep() {
    // 位姿推进
    state.sweepTimer = setInterval(() => {
      state.poseT += 1;
      if (state.poseT % (fast ? 1 : 10) === 0) {
        publishToSubscribers('/fast_lio_localization', poseMsg());
      }
    }, T.pose);

    // 电量：未充电缓慢下降 / 充电缓慢上升（原文未规定）
    state.workTimer = setInterval(() => {
      state.battery = state.charging
        ? Math.min(100, state.battery + 0.3)
        : Math.max(5, state.battery - 0.05);
      publishToSubscribers('/ebot_work_state', workStateMsg());
    }, T.workState);

    if (state.sweepTimer.unref) state.sweepTimer.unref();
    if (state.workTimer.unref) state.workTimer.unref();
  }

  // ---- 连接管理 -----------------------------------------------------------
  function removeClient(client) {
    clients.delete(client);
    for (const topic of client.topics) {
      const set = state.subscribers.get(topic);
      if (set) {
        set.delete(client);
        if (set.size === 0) state.subscribers.delete(topic);
      }
    }
    logger.info(`客户端 #${client.id} 断开，已清理其订阅`);
  }

  function onUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    // 手写握手：Sec-WebSocket-Accept = base64(sha1(key + GUID))
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n'
    );
    socket.setNoDelay(true);

    const client = {
      id: ++state.connSeq,
      socket,
      topics: new Set(),
      parser: createFrameParser(),
      fragOpcode: null,
      fragChunks: [],
      closed: false,
    };
    clients.add(client);
    logger.info(`客户端 #${client.id} 已连接（WebSocket 握手完成）`);

    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = client.parser.push(chunk);
      } catch (e) {
        logger.info(`帧解析异常，断开连接：${e.message}`);
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.opcode === 0x8) {
          // close 帧：回一条 close 并断开
          client.closed = true;
          try {
            socket.write(encodeCloseFrame(1000, ''));
          } catch (_) {}
          socket.end();
          return;
        } else if (f.opcode === 0x9) {
          // ping → pong（原样回带 payload）
          socket.write(encodePongFrame(f.payload));
        } else if (f.opcode === 0xa) {
          // pong：忽略
        } else if (f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0) {
          // 文本 / 二进制 / continuation
          if (f.opcode !== 0x0) {
            client.fragOpcode = f.opcode;
            client.fragChunks = [f.payload];
          } else {
            client.fragChunks.push(f.payload);
          }
          if (f.fin) {
            const full = Buffer.concat(client.fragChunks);
            client.fragChunks = [];
            const op = client.fragOpcode;
            client.fragOpcode = null;
            if (op === 0x1) {
              handleText(client, full.toString('utf8'));
            } else {
              logger.info('收到二进制帧（规格只定义 JSON 文本帧），已忽略');
            }
          }
        } else {
          logger.info(`收到未知 opcode ${f.opcode}，已忽略`);
        }
      }
    });

    socket.on('error', (e) => {
      logger.info(`客户端 #${client.id} socket 错误：${e.message}`);
      removeClient(client);
    });
    socket.on('close', () => removeClient(client));
  }

  // ---- HTTP 服务 + 启动/停止 ---------------------------------------------
  const server = http.createServer((req, res) => {
    // 非 WebSocket 请求：给一个简单的自检页，便于浏览器/curl 确认服务在跑
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      'TobotSlam3D mock-chassis (rosbridge mock)\n' +
        `请使用 WebSocket 连接：ws://${opts.host || '127.0.0.1'}:${currentPort()}\n` +
        'mode=' + (fast ? 'fast' : 'normal') + '\n'
    );
  });

  server.on('upgrade', onUpgrade);
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      logger.info(`端口被占用：${e.message}`);
    } else {
      logger.info(`服务器错误：${e.message}`);
    }
  });

  function currentPort() {
    const addr = server.address();
    return addr && typeof addr === 'object' ? addr.port : opts.port || 9090;
  }

  function start() {
    const port = typeof opts.port === 'number' ? opts.port : 9090;
    const host = opts.host || '127.0.0.1';
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        startSweep();
        if (!opts.quiet) {
          logger.info(`mock 底盘已启动：ws://${host}:${currentPort()}  模式=${fast ? 'fast' : 'normal'}`);
          logger.info(`预置地图 ${state.maps.length} 张：${state.maps.map((m) => m.map_name).join('、')}`);
          // 便于测试脚本自动发现端口（零依赖同进程启动）
          console.log(`MOCK_CHASSIS_READY ${JSON.stringify({ port: currentPort(), mode: fast ? 'fast' : 'normal' })}`);
        }
        resolve({ port: currentPort(), host, mode: fast ? 'fast' : 'normal' });
      });
    });
  }

  function stop() {
    stopPathPush();
    stopArrival();
    if (state.mapListTimer) clearInterval(state.mapListTimer);
    if (state.sweepTimer) clearInterval(state.sweepTimer);
    if (state.workTimer) clearInterval(state.workTimer);
    state.mapListTimer = state.sweepTimer = state.workTimer = null;
    for (const c of clients) {
      try {
        c.socket.destroy();
      } catch (_) {}
    }
    clients.clear();
    state.subscribers.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { start, stop, server, state, config: T, isFast: fast, currentPort, logger };
}

// ---------------------------------------------------------------------------
// 4) CLI 入口
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { port: 9090, fast: process.env.MOCK_FAST === '1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--fast') out.fast = true;
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`TobotSlam3D mock 底盘（rosbridge mock，零依赖）

用法：
  node server.js [--port 9090] [--fast] [--quiet]

参数：
  --port <n>   监听端口（默认 9090）
  --fast       快速模式：路径推送 200ms x 5 次，到达判定与回充提前
  --host <ip>  监听地址（默认 127.0.0.1）
  --quiet      不打印启动横幅（报文日志仍打印）

环境变量：
  MOCK_FAST=1  等价于 --fast
`);
    process.exit(0);
  }
  const mock = createMockChassis(args);
  mock.start().catch((e) => {
    console.error(`启动失败：${e.message}`);
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n[mock-chassis] 收到 ${sig}，正在关闭…`);
      mock.stop().then(() => process.exit(0));
    });
  }
}

module.exports = { createMockChassis, encodeTextFrame, encodeCloseFrame, createFrameParser, TOPIC_TYPE, SERVICE_TYPE };
