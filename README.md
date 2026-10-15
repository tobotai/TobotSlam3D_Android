# TobotSlam3D

面向 **Tbot 3D 激光雷达导航底盘** 的 Android 控制端应用。

参考旧版 [`tobotai/TobotSlam`](https://github.com/tobotai/TobotSlam)（2D 雷达版本）的项目形态，
但**通信层与渲染层完全重写**，因为新一代底盘的接口协议已经换成
**rosbridge WebSocket**（[官方 SDK 文档](http://www.tobotai.com/sdk/index.html)）。

界面按《Tbot3D导航底盘使用说明V1.0》第 3 章「界面功能分区」实现，
与 Web 控制面板（`http://<底盘IP>:8081`）一一对应。

---

## ⚠️ 先读这一节：三个必须知道的前提

### 1. 旧版用的不是自研协议，而是 Slamtec Slamware SDK —— 因此基本不可复用

对旧工程做静态分析后的结论（按 jar/aar 字节码与调用点逐条核对，结论见下表）：

| 项 | 旧版 TobotSlam 4.0.9 | 本工程 TobotSlam3D |
|---|---|---|
| 通信 | Slamtec **私有 TCP 协议，端口 1445**（`librpsdk.so` + `TobotSlam-2.12.5.jar`） | **rosbridge WebSocket，端口 9090** |
| ROS | **完全没有 ROS 痕迹** | 全部走 ROS 消息（`nav_msgs/*`、`std_msgs/*`、自定义 srv） |
| 地图渲染 | 100% 由闭源 `com.tobot.slam.view.MapView` 绘制（栅格图+点云+橡皮擦，13 个内部子 View） | **自研 `PathCanvasView`**，只画位姿与路径（见前提 2） |
| 闭源依赖 | 4 个 jar/aar + 2 个 .so | **零闭源依赖**，只用 androidx + okhttp |

`TobotSlam-2.12.5.jar` 内 253 个 class 中 132 个是 `com.slamtec.*`。
旧工程 134 个 Java 文件里有 45 个耦合闭源 SDK，其中地图渲染部分**没有任何应用侧代码可参考**。
所以本工程是**重写**，不是移植。

### 2. 新协议**不暴露**栅格地图与点云，所以画布只画路径与位姿

官方 SDK 只公开 5 个 Topic + 9 项 Service，其中**没有**占据栅格地图、地图图片、
3D 点云、TF、`cmd_vel`。这与旧版完全不同。

因此本应用的「路径显示画布」与 Web 面板的标题一致（截图里就是「**路径显示 (N 点)**」）：
只画 **实时位姿** + **规划路径** + **已保存目标点**。
**不要指望它能显示 SLAM 栅格地图** —— 协议里拿不到。

### 3. 手动遥控走的是 ROS 标准 `/cmd_vel`，官方文档没有写，**必须实测确认**

Web 控制面板确实有「手动控制」摇杆，说明底盘内部存在速度通路；
但公开的 SDK 文档**没有列出任何速度接口**。

本工程的做法：用 rosbridge 的 `advertise` + `publish`，向
`/cmd_vel`（`geometry_msgs/Twist`）下发速度。
**话题名做成了可配置**：长按界面上的「手动控制」标题即可修改。
上线前请用 `wscat` 实测出真实话题名再改。

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

## ⚠️ 未验证事项（请务必先读）

**本工程没有在本机编译过** —— 开发环境里没有 JDK、没有 Android SDK，
所以「能编译通过」这件事**尚未被证明**。

已经做到的验证：

- `node tools/check-android.js` 通过：XML 良构、`R.*` 引用全部存在、
  `findViewById` 的 id 全部定义、Java 括号配平、类名与文件名一致、
  跨文件 import 可解析、Manifest 引用的类与资源存在、协议名逐字符正确
- `node tools/conformance.test.js` 通过：协议契约与业务闭环（针对模拟底盘）

**尚未验证**：Android API 调用的编译正确性、真机运行表现、与真实底盘的联调。
首次 Sync/编译若报错，大概率是资源名或某个 API 签名的小问题，请看
[`docs/VERIFICATION.md`](docs/VERIFICATION.md) 的排查清单。

---

## 协议来源

- 官方 SDK 文档：<http://www.tobotai.com/sdk/index.html>
- 《Tbot3D导航底盘使用说明V1.0》（`download/pdf/Tbot3D导航底盘使用说明V1.0.pdf`）
- 工程内契约文件：`tools/protocol-contract.json`

技术支持：`support@tobotai.com`
