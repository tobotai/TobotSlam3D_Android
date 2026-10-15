package com.tobot.slam3d.core;

/**
 * Tobot 3D 导航底盘协议常量。
 *
 * 全部取值来自官方 SDK 文档（http://www.tobotai.com/sdk/index.html）
 * 与《Tbot3D导航底盘使用说明V1.0》第 5 章，以及工程内的
 * tools/protocol-contract.json。**这些字符串是与底盘通信的契约，改动会导致通信失败**，
 * 修改前请先跑 tools/check-contract.js。
 */
public final class TobotConstants {

    private TobotConstants() {
    }

    // ------------------------------------------------------------------ 连接默认值

    /** 底盘默认 IP（实测环境网段 192.168.1.x）。 */
    public static final String DEFAULT_HOST = "192.168.1.151";
    /** rosbridge WebSocket 端口。 */
    public static final int DEFAULT_WS_PORT = 9090;
    /** Web 控制面板端口（仅用于在浏览器里对照操作，App 不依赖它）。 */
    public static final int DEFAULT_PANEL_PORT = 8081;

    // ------------------------------------------------------------- 订阅 Topic（底盘 → 应用）

    /** 底盘当前位姿。 */
    public static final String TOPIC_POSE = "/fast_lio_localization";
    public static final String TYPE_POSE = "nav_msgs/Odometry";

    /** 规划全局路径；导航启动后约 5 秒一次、共约 5 次（约 30 秒），必须缓存最后一次。 */
    public static final String TOPIC_PATH = "/aft_pgo_path";
    public static final String TYPE_PATH = "nav_msgs/Path";

    /** 地图列表及每张地图下的目标点。 */
    public static final String TOPIC_MAP_LIST = "/map_list_kitty";
    public static final String TYPE_MAP_LIST = "kitty_runtime_manager/MapList";

    /** 导航状态：data[0]==1 表示到达。注意是完整名，不是 /ebot_goal_status。 */
    public static final String TOPIC_GOAL_STATUS = "/ebot_goal_status_local_planner";
    public static final String TYPE_GOAL_STATUS = "std_msgs/Float64MultiArray";

    /** 电量与充电状态。 */
    public static final String TOPIC_WORK_STATE = "/ebot_work_state";
    public static final String TYPE_WORK_STATE = "std_msgs/Float64MultiArray";

    // ------------------------------------------------------------- 调用 Service（应用 → 底盘）

    /** 启动建图。空请求。 */
    public static final String SVC_START_MAPPING = "/start_mapping_kitty";
    public static final String TYPE_START_MAPPING = "std_srvs/Trigger";

    /** 保存地图。参数名是 filepath，且只传地图名、不带路径。 */
    public static final String SVC_SAVE_MAP = "/save_map_kitty";
    public static final String TYPE_SAVE_MAP = "kitty_runtime_manager/SaveMap";

    /** 选择地图并启动导航。参数名是 filepath。 */
    public static final String SVC_SELECT_MAP = "/select_map_and_start_kitty";
    /** 原文把该服务类型也写作 SaveMap（并非笔误），此处按原文保留。 */
    public static final String TYPE_SELECT_MAP = "kitty_runtime_manager/SaveMap";

    /** 删除地图。注意参数名是 map_name，不是 filepath。 */
    public static final String SVC_DELETE_MAP = "/delete_map_kitty";
    public static final String TYPE_DELETE_MAP = "kitty_runtime_manager/DeleteMap";

    /** 回桩充电。success 只表示流程已启动，不代表已充上电。 */
    public static final String SVC_DOCKING = "/docking_kitty";
    public static final String TYPE_DOCKING = "std_srvs/Trigger";

    /** 导航到点；**取消导航也走这个服务**，用魔数坐标区分。 */
    public static final String SVC_NAVIGATE = "/navigate_to_pose";
    public static final String TYPE_NAVIGATE = "nav_msgs/GetPlan";

    /** 添加目标点。 */
    public static final String SVC_ADD_GOAL = "/add_goal_kitty";
    public static final String TYPE_ADD_GOAL = "kitty_runtime_manager/AddGoal";

    /** 删除目标点。 */
    public static final String SVC_DELETE_GOAL = "/delete_goal_kitty";
    public static final String TYPE_DELETE_GOAL = "kitty_runtime_manager/DeleteGoal";

    // ------------------------------------------------------------------ 字段名

    public static final String FIELD_FILEPATH = "filepath";
    public static final String FIELD_MAP_NAME = "map_name";
    public static final String FIELD_GOAL_NAME = "goal_name";
    public static final String FIELD_THETA = "theta";
    public static final String FIELD_GOALS = "goals";
    public static final String FIELD_MAPS = "maps";
    public static final String FIELD_MAP_PATH = "map_path";
    public static final String FIELD_POSES = "poses";
    public static final String FIELD_DATA = "data";
    public static final String FIELD_NAME = "name";

    // ------------------------------------------------------------------ rosbridge 报文字段

    public static final String OP = "op";
    public static final String OP_SUBSCRIBE = "subscribe";
    public static final String OP_CALL_SERVICE = "call_service";
    public static final String OP_PUBLISH = "publish";
    public static final String OP_SERVICE_RESPONSE = "service_response";
    public static final String KEY_TOPIC = "topic";
    public static final String KEY_TYPE = "type";
    public static final String KEY_SERVICE = "service";
    public static final String KEY_ARGS = "args";
    public static final String KEY_MSG = "msg";
    public static final String KEY_VALUES = "values";
    public static final String KEY_RESULT = "result";
    public static final String KEY_SUCCESS = "success";
    public static final String KEY_MESSAGE = "message";
    public static final String KEY_PLAN = "plan";

    // ------------------------------------------------- 手动遥控（官方 SDK 文档未列出，需实测确认）

    /**
     * 手动遥控速度话题名。
     *
     * <p>⚠️ <b>重要说明</b>：官方 SDK 文档只列出 5 个 Topic + 9 项 Service，
     * <b>没有</b>公开任何速度控制接口；但 Web 控制面板确实有「手动控制」摇杆。
     * 说明底盘内部存在速度通路，只是未写进公开 SDK 文档。
     *
     * <p>因此这里按 ROS 通用约定使用 {@code /cmd_vel} + {@code geometry_msgs/Twist}
     * 通过 rosbridge 的 {@code advertise} + {@code publish} 下发。
     * <b>上线前请用 wscat 实测确认话题名与消息类型</b>，并在设置界面按实测结果修改。
     */
    public static final String DEFAULT_CMD_VEL_TOPIC = "/cmd_vel";
    public static final String TYPE_TWIST = "geometry_msgs/Twist";
    public static final String OP_ADVERTISE = "advertise";

    /** 手动遥控下发频率（毫秒）。 */
    public static final long MANUAL_PUBLISH_INTERVAL_MS = 100L;

    /** 默认最大线速度（对应 Web 面板默认值 0.2）。 */
    public static final float DEFAULT_MAX_LINEAR = 0.2f;
    /** 默认最大角速度（对应 Web 面板默认值 0.5）。 */
    public static final float DEFAULT_MAX_ANGULAR = 0.5f;

    // ------------------------------------------------------------------ 取消导航魔数
    /**
     * 取消导航的魔数坐标：给 {@link #SVC_NAVIGATE} 传 x=999999, y=888888, z=0。
     * 底盘会停止当前导航并原地停车，响应 plan.poses 为空。
     */
    public static final double CANCEL_X = 999999d;
    public static final double CANCEL_Y = 888888d;

    // ------------------------------------------------------------------ 状态语义

    /** /ebot_goal_status_local_planner 的 data[0]：到达。 */
    public static final int GOAL_STATUS_ARRIVED = 1;
    /** /ebot_goal_status_local_planner 的 data[0]：未到达。 */
    public static final int GOAL_STATUS_NOT_ARRIVED = 0;

    /** /ebot_work_state 的 data[0]：充电中。 */
    public static final int WORK_STATE_CHARGING = 1;
    /** /ebot_work_state 的 data[0]：未充电。**注意是 2，不是 0**。 */
    public static final int WORK_STATE_NOT_CHARGING = 2;
    /** /ebot_work_state 的 data[1]：电量百分比下标。 */
    public static final int WORK_STATE_BATTERY_INDEX = 1;

    /** 底盘坐标系下 z 恒为 0。 */
    public static final double Z_ALWAYS_ZERO = 0d;

    /** 自动重连的最大尝试次数（原文未规定，属工程默认值）。 */
    public static final int MAX_RECONNECT_ATTEMPTS = 5;
    /** 自动重连的基础退避毫秒数（原文未规定，属工程默认值）。 */
    public static final long RECONNECT_BASE_DELAY_MS = 1500L;

    // ------------------------------------------------------------------ 契约校验用逐字符样例

    /**
     * 与 tools/protocol-contract.json 的 verbatimWireSamples 一一对应的报文样例。
     * tools/check-contract.js 会断言这些字符串在源码中存在，防止有人改错 topic / service 名。
     */
    public static final String[] VERBATIM_WIRE_SAMPLES = new String[]{
            "{\"op\":\"subscribe\",\"topic\":\"/fast_lio_localization\",\"type\":\"nav_msgs/Odometry\"}",
            "{\"op\":\"subscribe\",\"topic\":\"/aft_pgo_path\",\"type\":\"nav_msgs/Path\"}",
            "{\"op\":\"subscribe\",\"topic\":\"/map_list_kitty\",\"type\":\"kitty_runtime_manager/MapList\"}",
            "{\"op\":\"subscribe\",\"topic\":\"/ebot_goal_status_local_planner\",\"type\":\"std_msgs/Float64MultiArray\"}",
            "{\"op\":\"subscribe\",\"topic\":\"/ebot_work_state\",\"type\":\"std_msgs/Float64MultiArray\"}",
            "{\"op\":\"call_service\",\"service\":\"/start_mapping_kitty\",\"args\":{}}",
            "{\"op\":\"call_service\",\"service\":\"/docking_kitty\",\"args\":{}}",
            "{\"op\":\"call_service\",\"service\":\"/navigate_to_pose\",\"args\":{\"goal\":{\"pose\":{\"position\":{\"x\":999999,\"y\":888888,\"z\":0}}}}}"
    };
}
