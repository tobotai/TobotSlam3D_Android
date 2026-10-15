# mock-chassis —— TobotSlam3D 协议测试夹具（模拟 3D 雷达导航底盘）

零依赖的 **rosbridge WebSocket 服务端**，用来在没有真实底盘硬件的情况下验证
Android 端「TobotSlam3D」的通信协议与业务流程。

- **唯一事实来源**：[`../protocol-contract.json`](../protocol-contract.json)
- **零依赖**：不使用 `ws` / `socket.io` 等任何 npm 包。WebSocket 服务端是**手写实现**：
  `node:http` + `'upgrade'` 事件、`Sec-WebSocket-Accept` 握手、文本帧解析与编码
  （含 126 / 127 两种扩展长度）、掩码解码、close 帧、ping/pong、分片（continuation frame）。
- **不改动** `TobotSlam3D/app/` 下任何内容。

---

## 一、启动

```bash
# 默认监听 ws://127.0.0.1:9090（契约里的端口）
node tools/mock-chassis/server.js

# 自定义端口
node tools/mock-chassis/server.js --port 19090

# 快速模式：路径推送 200ms × 5 次、到达判定与回充提前（适合自动化联调）
node tools/mock-chassis/server.js --fast
MOCK_FAST=1 node tools/mock-chassis/server.js      # 等价写法

# 其它
node tools/mock-chassis/server.js --host 0.0.0.0   # 监听地址（默认 127.0.0.1）
node tools/mock-chassis/server.js --quiet          # 不打印启动横幅（报文日志仍打印）
node tools/mock-chassis/server.js --help
```

端口选择注意：`--port 0` 表示「由系统分配空闲端口」，启动时会打印一行机器可读信息

```
MOCK_CHASSIS_READY {"port":59524,"mode":"fast"}
```

`conformance.test.js` 就是靠它拿到实际端口（避免占用 9090）。

### 参数表

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port <n>` | `9090` | 监听端口，`0` = 系统分配空闲端口 |
| `--host <ip>` | `127.0.0.1` | 监听地址 |
| `--fast` | 关 | 快速模式，见下表 |
| `--quiet` | 关 | 不打印启动横幅 |
| `MOCK_FAST=1` | — | 等价于 `--fast` |

### 普通 / 快速模式的时间参数

| 行为 | 普通模式 | `--fast` |
| --- | --- | --- |
| `/aft_pgo_path` 推送 | 5000ms × 5 次（贴合原文「约 5 秒一次共 5 次」） | 200ms × 5 次 |
| 导航模拟行驶 → 到达 `data[0]=1` | 6000ms | 1500ms |
| 回充后进入充电状态 | 500ms | 100ms |
| `/fast_lio_localization` 推送 | 100ms（内部每 10 帧发一次位姿更新） | 100ms |
| `/map_list_kitty` 周期重推 | 5000ms | 1000ms |
| `/ebot_work_state` 周期推送 | 1000ms | 200ms |

### 控制台报文日志

每条**收到**与**发出**的报文都会打印，带方向前缀（`←` 收 / `→` 发）：

```
[09:14:54.023] ← call_service {"op":"call_service","service":"/save_map_kitty","args":{"filepath":"test_map"},"id":"3"}
[09:14:54.028] [mock-chassis] 已保存地图 "test_map"
[09:14:54.028] → service_response /save_map_kitty {"op":"service_response","service":"/save_map_kitty","values":{"success":true,"message":"Map saved"},"result":true,"id":"3"}
```

### 作为模块使用（同进程拉起，测试用）

```js
const { createMockChassis } = require('./tools/mock-chassis/server.js');
const mock = createMockChassis({ port: 0, fast: true, log: false });
const info = await mock.start();   // { port, host, mode }
// ... 跑用例 ...
await mock.stop();
```

---

## 二、wscat 手工验证（原文第五节的 CLI 方式）

```bash
npm install -g wscat
wscat -c ws://127.0.0.1:9090
```

连上后逐条粘贴（**逐字符**，与契约 `verbatimWireSamples` 完全一致）：

```
{"op":"subscribe","topic":"/fast_lio_localization","type":"nav_msgs/Odometry"}
{"op":"subscribe","topic":"/aft_pgo_path","type":"nav_msgs/Path"}
{"op":"subscribe","topic":"/map_list_kitty","type":"kitty_runtime_manager/MapList"}
{"op":"subscribe","topic":"/ebot_goal_status_local_planner","type":"std_msgs/Float64MultiArray"}
{"op":"subscribe","topic":"/ebot_work_state","type":"std_msgs/Float64MultiArray"}
```

原文那段「快速自测」在这里同样适用：

```
# 订阅电量（会每 1 秒推一次 data[0]=1 或 2，data[1]=电量%）
{"op":"subscribe","topic":"/ebot_work_state","type":"std_msgs/Float64MultiArray"}

# 回充，观察 service_response
{"op":"call_service","service":"/docking_kitty","args":{}}
# 期望：{"op":"service_response","service":"/docking_kitty","values":{"success":true,"message":"Docking started"},"result":true}
```

完整业务闭环（建图 → 存图 → 选图 → 加点 → 导航 → 取消 → 回充 → 删点 → 删图）：

```
{"op":"call_service","service":"/start_mapping_kitty","args":{}}
{"op":"call_service","service":"/save_map_kitty","args":{"filepath":"test_map"}}
{"op":"call_service","service":"/select_map_and_start_kitty","args":{"filepath":"test_map"}}
{"op":"call_service","service":"/add_goal_kitty","args":{"map_name":"test_map","goal_name":"front","x":1.0,"y":2.0,"theta":0.5}}
{"op":"call_service","service":"/navigate_to_pose","args":{"goal":{"pose":{"position":{"x":1.0,"y":2.0,"z":0.0}}}}}
{"op":"call_service","service":"/navigate_to_pose","args":{"goal":{"pose":{"position":{"x":999999,"y":888888,"z":0}}}}}
{"op":"call_service","service":"/docking_kitty","args":{}}
{"op":"call_service","service":"/delete_goal_kitty","args":{"map_name":"test_map","goal_name":"front"}}
{"op":"call_service","service":"/delete_map_kitty","args":{"map_name":"test_map"}}
```

故意做错，验证 mock 能抓出客户端 bug：

```
# 1) filepath 带了路径 → 必须失败
{"op":"call_service","service":"/save_map_kitty","args":{"filepath":"/bad/path"}}
# 期望：values.success=false，message 含 "plain map name"

# 2) 删图误传 filepath 字段 → 必须失败
{"op":"call_service","service":"/delete_map_kitty","args":{"filepath":"test_map"}}
# 期望：values.success=false，message 指出应该用 map_name

# 3) 未知服务 → result:false
{"op":"call_service","service":"/nope_kitty","args":{}}
# 期望：{"op":"service_response","service":"/nope_kitty","values":{"success":false,"message":"unknown service"},"result":false}
```

启动时的预置数据（便于模拟真实环境）：

| 地图 | map_path | 目标点 |
| --- | --- | --- |
| `2026.9.20` | `/maps/2026.9.20` | `1` (5.23, -0.20)、`2` (6.58, -1.36) |
| `测试_2026_09_09` | `/maps/测试_2026_09_09` | 无（空目标点，用于验证空列表 UI） |

---

## 三、按原文规格实现 vs. mock 便利行为

> 判断标准：`protocol-contract.json` + 《Tbot 3D 导航底盘 SDK 接口协议规格》。
> 「原文未说明」的一律标注为 mock 的便利选择，**不代表底盘真实行为**。

### ✅ 严格按原文规格实现（可直接作为契约判据）

| 项 | 实现 |
| --- | --- |
| 连接方式 | `ws://<host>:9090`，rosbridge WebSocket，JSON 文本帧，`op` 字段驱动 |
| 订阅包络 | `{"op":"subscribe","topic":"<topic>","type":"<type>"}` |
| 推送包络 | `{"op":"publish","topic":"<topic>","msg":{...}}`，数据在 `msg` |
| 服务响应包络 | `{"op":"service_response","service":"<原样回显>","values":{...},"result":true}`，数据在 `values` |
| 5 个 topic 名称与类型 | `/fast_lio_localization` `nav_msgs/Odometry`；`/aft_pgo_path` `nav_msgs/Path`；`/map_list_kitty` `kitty_runtime_manager/MapList`；`/ebot_goal_status_local_planner` `std_msgs/Float64MultiArray`；`/ebot_work_state` `std_msgs/Float64MultiArray` |
| 8 个服务名 + 类型（9 项功能） | 见下（`/select_map_and_start_kitty` 的类型**按原文**仍写 `kitty_runtime_manager/SaveMap`） |
| 服务响应文案 | `Mapping started` / `Map saved` / `Map selected and navigation started` / `Deleted successfully` / `Docking started` / `Added successfully` / 导航返回 `plan.poses` / 取消返回 `plan.poses: []` |
| `z` 恒为 0 | `/fast_lio_localization` 的 `pose.pose.position.z`、`/aft_pgo_path` 的 `poses[].pose.position.z`、请求里 `goal.pose.position.z` 全部 0 |
| 四元数 | 只绕 z 轴：`x=y=0, z=sin(yaw/2), w=cos(yaw/2)`，模为 1 |
| 到达判据 | 只有 `/ebot_goal_status_local_planner` 的 `data[0]==1` 才算到达；`/navigate_to_pose` 的响应**不**表示到达 |
| 取消导航 | `/navigate_to_pose` 传 `x=999999, y=888888, z=0` → 停止导航、`plan.poses: []`，**不再发 `data[0]=1`** |
| 充电状态取值 | `data[0]`：`1`=充电，`2`=未充电，**从不出现 0** |
| `filepath` 只传地图名 | 带 `/` 或 `\` 的值判失败（mock 主动抓错，见下） |
| `delete_map_kitty` 用 `map_name` | 字段名严格；误传 `filepath` 判失败 |
| `/aft_pgo_path` 只在导航启动后推 | 未导航时**不推**；推送 5 次后停止（原文：约 5s × 5 次） |
| `/map_list_kitty` 订阅后立即推 | 原文：「订阅后返回所有地图及其已保存目标点」 |
| 未知 service | `values.success=false, message="unknown service"`，`result:false` |

### 🔧 mock 的便利行为（原文未说明 / 原文未规定 → 请勿当作底盘真实行为）

| # | 便利行为 | 说明 |
| --- | --- | --- |
| 1 | **`/map_list_kitty` 会周期性重推 + 每次增删改后重推** | 原文只说「订阅后返回」；`specGaps` 明确「MapList 是否周期推送、增删改后是否自动重推：原文未说明」。mock 这样做是为了让测试不必反复重新订阅。**Android 端不要依赖它自动刷新**（保守做法：增删改后重新订阅）。 |
| 2 | `/fast_lio_localization` 推送周期 100ms | 原文只说「定时推送」，周期未说明 |
| 3 | `/ebot_work_state` 推送周期 1s（fast: 200ms） | 原文未说明；电量未充电时缓慢下降、充电时缓慢上升 |
| 4 | `/ebot_goal_status_local_planner` 推送时机 | 原文未说明。mock：导航开始推一次 `[0]`，行驶结束后推 `[1]`；不导航时不推 |
| 5 | `service_response` 里的 **`id` 回显** | 原文所有裸 WebSocket 示例都不带 `id`，`specGaps` 明确「rosbridge id 字段配对：原文未说明」。mock 只在客户端**发了** `id` 时回显，没发就不带该字段。 |
| 6 | `/save_map_kitty` 对带路径的 `filepath` 返回 `success:false` | 原文只说「filepath 只传地图名」，未规定失败行为。mock 主动判失败以便**抓客户端把 `map_path` 当地图名传**的 bug |
| 7 | `/delete_map_kitty` 误传 `filepath` 返回 `success:false` | 同上，帮助抓字段名混用 |
| 8 | 删除地图的响应文案为 `Deleted successfully` | 契约表格里该服务的 `message` 即写作 `Deleted successfully`（原文未单独给删图文案），删点同文案 |
| 9 | `/docking_kitty` 后自动进入充电状态 | 原文：`success` 只表示流程已启动；「只有真正充上电才发 1」。mock 在 0.5s（fast: 0.1s）后把 `/ebot_work_state` 的 `data[0]` 置 1 —— **注意 mock 不因此推 `/ebot_goal_status_local_planner` 的 1**（保持「不导航就不发到达」） |
| 10 | 导航「模拟行驶」时长 6s（fast: 1.5s） | 原文未说明到达耗时 |
| 11 | `/navigate_to_pose` 响应里的路径点数 = 10（起终点各 1 + 8 个插值点） | 原文只给了 2 点的示例，点数未规定 |
| 12 | `save_map` 立即建一张空地图；`add_goal` 对不存在的地图自动建图 | 原文未说明持久化与容错行为 |
| 13 | 启动预置 2 张地图 | 原文未规定初始数据 |
| 14 | 畸形 JSON 会回一条 `service_response`（`service:""`、`result:false`） | 原文未规定错误包络；mock 保证客户端能看出自己发了坏包 |
| 15 | 客户端 `publish` 报文只记日志、不处理 | 底盘是服务端，原文未定义应用向底盘 publish 的语义 |

### 原文自身瑕疵（mock 不复制这些坑，但 Android 端要注意）

- 侧边栏把 topic 简写成 `/ebot_goal_status`，**真实全名是 `/ebot_goal_status_local_planner`**（mock 只认全名）。
- 原文 Java/C/C#/Go 的「完整示例」都漏发了取消导航那条调用（只有 8 条服务调用）。
- `/select_map_and_start_kitty` 的类型原文写作 `kitty_runtime_manager/SaveMap`（与存图同类型），不是笔误，按原文传。

---

## 四、服务速查（mock 行为）

| Service | 类型 | args | 成功响应 `values` |
| --- | --- | --- | --- |
| `/start_mapping_kitty` | `std_srvs/Trigger` | `{}` | `{"success":true,"message":"Mapping started"}` |
| `/save_map_kitty` | `kitty_runtime_manager/SaveMap` | `{"filepath":"<纯地图名>"}` | `{"success":true,"message":"Map saved"}` |
| `/select_map_and_start_kitty` | `kitty_runtime_manager/SaveMap` | `{"filepath":"<纯地图名>"}` | `{"success":true,"message":"Map selected and navigation started"}` |
| `/delete_map_kitty` | `kitty_runtime_manager/DeleteMap` | `{"map_name":"<地图名>"}` | `{"success":true,"message":"Deleted successfully"}` |
| `/docking_kitty` | `std_srvs/Trigger` | `{}` | `{"success":true,"message":"Docking started"}` |
| `/navigate_to_pose`（导航） | `nav_msgs/GetPlan` | `{"goal":{"pose":{"position":{"x":X,"y":Y,"z":0.0}}}}` | `{"plan":{"poses":[...]}}` |
| `/navigate_to_pose`（取消） | `nav_msgs/GetPlan` | `x=999999, y=888888, z=0` | `{"plan":{"poses":[]}}` |
| `/add_goal_kitty` | `kitty_runtime_manager/AddGoal` | `{"map_name","goal_name","x","y","theta"}` | `{"success":true,"message":"Added successfully"}` |
| `/delete_goal_kitty` | `kitty_runtime_manager/DeleteGoal` | `{"map_name","goal_name"}` | `{"success":true,"message":"Deleted successfully"}` |

`theta` 单位是**弧度**。

---

## 五、配套脚本

| 脚本 | 作用 |
| --- | --- |
| `../conformance.test.js` | 端到端一致性测试：自动拉起本 mock，跑完 14 步业务闭环并逐项断言（失败 `exit 1`）。当前 **73/73 通过** |
| `../check-contract.js` | 静态契约校验：扫描 Android Java 源码，确认 5 topic / 8 service 的名称与类型字面量存在、服务调用点参数字段正确、无 2D 旧协议残留。当前 **63/63 通过** |

```bash
cd TobotSlam3D/tools
node conformance.test.js        # 端到端（约 5 秒，自动用 --fast 模式）
node check-contract.js          # 静态校验（源码目录不存在时打印「尚未生成，跳过」并 exit 0）
```

### `check-contract.js` 的判定方式（避免误报）

- **字符串字面量 + 常量符号双重解析**：Java 里大量使用 `TobotConstants.FIELD_MAP_NAME` 这类符号引用，
  校验器会先建立「常量名 → 字面量」表，再做符号解析，不会因为「只写了常量名」而误判。
- **服务参数名只看真正的调用表达式**：匹配
  `callService(TobotConstants.SVC_xxx, RosbridgeMessages.yyyArgs(...))`，
  再解析 `yyyArgs()` 方法体里用 `FIELD_*` 常量拼出来的 JSON 键集合，与契约字段表对齐
  （`SVC_DELETE_MAP → mapNameArgs → {map_name}`、`SVC_SAVE_MAP / SVC_SELECT_MAP → filepathArgs → {filepath}`）。
  **不使用「行号邻近」或「文件里同时出现两个字符串」这种启发式**。
- **`/cmd_vel` + `geometry_msgs/Twist` 只提示、不判失败**：官方 SDK 文档只公开 5 Topic + 9 Service，
  没有速度接口；本工程按 ROS 通用约定额外实现了手动遥控通路（见 `docs/PROTOCOL.md`），
  这属于**契约之外的工程扩展**，因此校验器只输出 `ℹ️ 提示`，不计入 PASS/FAIL。
- 注释会被先剥离，所以「注释里提到旧 topic 名」不会被误判为源码残留。
- 已做变异测试（把 `filepathArgs` 误用到 `SVC_DELETE_MAP`、把 topic 写成旧简写 `/ebot_goal_status`），
  三种变异均被抓出并 `exit 1`。

---

## 六、已知环境限制：本机 Node 内置 WebSocket **客户端**不可用

在 Node **v24.21.0**（Windows x64）上**实测**：

- 本 mock 服务端的握手与帧编解码是**正确**的：用 `node:http` 的 `'upgrade'` 事件手写客户端连接，
  可拿到 `101 Switching Protocols`、合法 `Sec-WebSocket-Accept`，并正常收发文本帧（含 126 扩展长度）。
- 但用 Node **内置全局 `WebSocket`** 连**任何**本地 upgrade 端点都会立刻抛
  `TypeError at #onSocketClose (node:internal/deps/undici/undici:15787:20)`，且 `error` 事件的 `message` 为空。
- 对照实验（同一台机器、同一个服务端）：合法 accept / 错误 accept / 返回 `200 OK` 三种情况抛出的错
  **完全一样**，说明失败发生在 undici 建立连接之后，**与本 mock 服务端无关**。

因此 `conformance.test.js` 采用「自动协商」的客户端策略：

```
默认        先试内置 WebSocket（1.2 秒），连不上就用内置的手写客户端（同一条 WebSocket 协议）
--native-ws 强制只用内置 WebSocket（当前本机会失败，用于将来 Node 修复后复验）
--raw-ws    强制只用手写客户端
```

测试第 1 步会打印实际使用的是哪一种客户端。内置的 `createRawWebSocketClient()`
完整实现了握手（校验 `Sec-WebSocket-Accept`）、掩码帧编码、ping/pong、close 与分片聚合 ——
它既是「零依赖」承诺的兜底，也顺带验证了服务端帧编解码的正确性。

