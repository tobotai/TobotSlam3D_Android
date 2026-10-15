# TobotSlam3D

面向 **Tbot 3D 激光雷达导航底盘** 的 Android 控制端应用。

新一代底盘的接口协议已经换成
**rosbridge WebSocket**（[官方 SDK 文档](http://www.tobotai.com/sdk/index.html)）。

---

## 构建

### 环境要求

| 项 | 版本 |
|---|---|
| Android Studio | **Hedgehog (2023.1.1) 或更新** |
| JDK | **17**（Android Studio 自带） |
| Gradle | 8.2（wrapper 已带，无需另装） |
| Android Gradle Plugin | 8.1.4 |
| compileSdk / targetSdk | 34 |
| minSdk | 24（Android 7.0） |
| Build Tools | 34.0.0（SDK Manager 里装一下） |

> 如果你的 Android Studio 较老（Dolphin ~ Giraffe），把根 `build.gradle` 的 AGP 降到
> `7.4.2`、`gradle/wrapper/gradle-wrapper.properties` 的 Gradle 降到 `7.5`、
> `compileSdk`/`targetSdk` 降到 `33`，其余不用改。

### 步骤

```bash
# 1. 用 Android Studio 打开本目录（TobotSlam3D），等待 Gradle Sync
# 2. 若提示缺少 SDK，按提示安装 Android SDK Platform 34 + Build-Tools 34.0.0
# 3. 连接安卓设备（与底盘同一局域网），点 Run
# 4. 或命令行构建：
./gradlew assembleDebug        # 产物：app/build/outputs/apk/debug/app-debug.apk
```

首次运行请在界面顶部的「服务地址」里填写底盘实际 IP（默认 `ws://192.168.1.151:9090`），
地址会保存在本地，下次自动连接。

---

## 功能对照（与 Web 控制面板一致）

| 分区 | 控件 | 对应协议 |
|---|---|---|
| **连接与状态区** | 服务地址输入框、连接/停止连接、最新信息、位姿、电量 | 连接 `ws://<ip>:9090`；位姿 `/fast_lio_localization`；电量 `/ebot_work_state` |
| **路径显示画布** | 路径点数标题、刷新/放大/缩小/全屏适配、缩放与平移显示 | `/aft_pgo_path`、`/fast_lio_localization` |
| **建图功能** | 开始建图、保存地图（弹名称输入框） | `/start_mapping_kitty`、`/save_map_kitty` |
| **导航功能** | 地图下拉、选择地图和启动导航、删除地图、添加目标点、删除目标点、目标点下拉、导航到选中目标、取消导航、回桩 | `/map_list_kitty`、`/select_map_and_start_kitty`、`/delete_map_kitty`、`/add_goal_kitty`、`/delete_goal_kitty`、`/navigate_to_pose`、`/docking_kitty`、`/ebot_goal_status_local_planner` |
| **手动控制** | 圆形摇杆、最大线速度、最大角速度 | `/cmd_vel`（**官方文档未列出，见前提 3**） |

细节与逐字段说明见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

### 交互上刻意对齐 Web 面板的几点

- 进入界面**自动连接**（与 Web 面板一致），点「停止连接」断开
- **未选择地图时**，「删除地图 / 添加目标点 / 删除目标点」按钮**置灰**（手册 §3.4）
- 「添加目标点」**按底盘当前位置与朝向保存**（`x, y, yaw` 直接取自 `/fast_lio_localization`，
  yaw 由四元数按官方公式换算）
- 「回桩」的响应只代表**流程已启动**；是否真充上电看 `/ebot_work_state` 的 `data[0]==1`
- **到达判据不看导航响应**，只看 `/ebot_goal_status_local_planner` 的 `data[0]==1`（手册 §5.3 明确要求）
- 路径只在导航后约 30 秒内推送（5 秒一次共 5 次），所以**收到后一直缓存**，不会因为推送停止而清空

---

## 无硬件时的自测

工程自带一套纯 Node 的测试夹具（不需要 npm install）：

```bash
cd tools
node mock-chassis/server.js          # 启动模拟底盘，监听 ws://127.0.0.1:9090
node conformance.test.js             # 端到端跑完整业务闭环并断言
wscat -c ws://127.0.0.1:9090         # 手工联调（需 npm i -g wscat）
```

然后把 App 的服务地址改成 `ws://127.0.0.1:9090`（模拟器里用 `10.0.2.2`）即可全流程演练。

---

## 工程结构

```
TobotSlam3D/
├── app/src/main/java/com/tobot/slam3d/
│   ├── App.java                     Application，持有全局仓库
│   ├── core/
│   │   ├── TobotConstants.java      协议常量（Topic/Service/字段名/魔数）★
│   │   └── Pose2D.java              二维位姿与四元数换算
│   ├── model/                       Goal / MapInfo / BatteryState / ChassisSnapshot
│   ├── net/
│   │   ├── RosbridgeMessages.java   报文构造（手工拼字符串，字节可预测）★
│   │   ├── RosbridgeParser.java     报文解析（全部用 opt*，缺字段不崩）
│   │   └── RosbridgeClient.java     WebSocket 客户端（心跳/自动重连/主线程派发）
│   ├── data/
│   │   ├── Prefs.java               地址、速度上限、手动遥控话题
│   │   └── ChassisRepository.java   状态 + 业务编排 ★
│   └── ui/
│       ├── MainActivity.java        唯一界面，五个功能分区
│       ├── PathCanvasView.java      自研路径画布（网格/路径/位姿/目标点/手势）
│       └── JoystickView.java        自绘摇杆
├── app/src/main/res/                布局、配色、中英文案
└── tools/
    ├── protocol-contract.json       协议契约（单一事实来源）
    ├── check-android.js             静态一致性校验（无 JDK 也能跑）
    ├── conformance.test.js          端到端协议测试
    └── mock-chassis/server.js       模拟底盘（纯 Node，零依赖）
```

★ = 与协议强相关的核心文件，改动前请先跑 `node tools/check-android.js`。

---

## 协议来源

- 官方 SDK 文档：<http://www.tobotai.com/sdk/index.html>
- 《Tbot3D导航底盘使用说明V1.0》（`download/pdf/Tbot3D导航底盘使用说明V1.0.pdf`）
- 工程内契约文件：`tools/protocol-contract.json`

技术支持：`support@tobotai.com`
