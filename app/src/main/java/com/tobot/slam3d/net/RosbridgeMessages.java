package com.tobot.slam3d.net;

import com.tobot.slam3d.core.TobotConstants;

import java.util.Locale;

/**
 * rosbridge 报文构造。
 *
 * <p>这里**手工拼接字符串**而不是用 {@code org.json}，原因是：
 * <ul>
 *   <li>发出去的字节完全可预测，能被 tools/check-contract.js 逐字符校验；</li>
 *   <li>避开 Android 自带 org.json 的受检异常（{@code JSONObject.put} 会抛 JSONException）；</li>
 *   <li>字段顺序稳定，便于抓包比对。</li>
 * </ul>
 * 非 ASCII 字符（例如中文目标点名称）按 UTF-8 原样输出，由 WebSocket 层保证编码。
 */
public final class RosbridgeMessages {

    private RosbridgeMessages() {
    }

    // ------------------------------------------------------------------ 报文包络

    /** 订阅报文：{@code {"op":"subscribe","topic":...,"type":...}}。 */
    public static String subscribe(String topic, String type) {
        return "{\"op\":\"" + TobotConstants.OP_SUBSCRIBE + "\",\"topic\":" + quote(topic)
                + ",\"type\":" + quote(type) + "}";
    }

    /**
     * 服务调用报文：{@code {"op":"call_service","service":...,"args":...}}。
     *
     * @param argsJson 已构造好的 args JSON 对象文本，取自本类的各个 {@code *Args()} 方法
     */
    public static String callService(String service, String argsJson) {
        return "{\"op\":\"" + TobotConstants.OP_CALL_SERVICE + "\",\"service\":" + quote(service)
                + ",\"args\":" + argsJson + "}";
    }

    // ------------------------------------------------------------------ 各个 args

    /** 空请求，用于 Trigger 类服务（start_mapping_kitty / docking_kitty）。 */
    public static String emptyArgs() {
        return "{}";
    }

    /**
     * 保存地图 / 选择地图并启动导航的参数。
     * <p>⚠️ 字段名是 {@code filepath}，且**只传地图名、不能带路径**。
     */
    public static String filepathArgs(String mapName) {
        return "{\"" + TobotConstants.FIELD_FILEPATH + "\":" + quote(mapName) + "}";
    }

    /**
     * 删除地图的参数。
     * <p>⚠️ 字段名是 {@code map_name}，与保存/选择地图的 {@code filepath} **不同**。
     */
    public static String mapNameArgs(String mapName) {
        return "{\"" + TobotConstants.FIELD_MAP_NAME + "\":" + quote(mapName) + "}";
    }

    /**
     * 添加目标点。
     *
     * @param theta 朝向，单位**弧度**
     */
    public static String addGoalArgs(String mapName, String goalName, double x, double y, double theta) {
        return "{\"" + TobotConstants.FIELD_MAP_NAME + "\":" + quote(mapName)
                + ",\"" + TobotConstants.FIELD_GOAL_NAME + "\":" + quote(goalName)
                + ",\"x\":" + num(x)
                + ",\"y\":" + num(y)
                + ",\"" + TobotConstants.FIELD_THETA + "\":" + num(theta) + "}";
    }

    /** 删除目标点。 */
    public static String deleteGoalArgs(String mapName, String goalName) {
        return "{\"" + TobotConstants.FIELD_MAP_NAME + "\":" + quote(mapName)
                + ",\"" + TobotConstants.FIELD_GOAL_NAME + "\":" + quote(goalName) + "}";
    }

    /**
     * 导航到指定坐标。
     * <p>请求体只带 position（没有 orientation），要指定到达朝向只能先用 add_goal。
     * z 恒传 0。
     */
    public static String navigateArgs(double x, double y) {
        return "{\"goal\":{\"pose\":{\"position\":{\"x\":" + num(x)
                + ",\"y\":" + num(y) + ",\"z\":0}}}}";
    }

    /**
     * 取消导航：给 {@code /navigate_to_pose} 传魔数坐标
     * x=999999, y=888888, z=0，底盘停止导航并原地停车。
     */
    public static String cancelNavigateArgs() {
        return "{\"goal\":{\"pose\":{\"position\":{\"x\":999999,\"y\":888888,\"z\":0}}}}";
    }

    // ------------------------------------------------------------------ 手动遥控（官方 SDK 文档未列出）

    /**
     * 宣告要发布的话题：{@code {"op":"advertise","topic":...,"type":...}}。
     * 通过 rosbridge 发布消息前必须先 advertise。
     */
    public static String advertise(String topic, String type) {
        return "{\"op\":\"" + TobotConstants.OP_ADVERTISE + "\",\"topic\":" + quote(topic)
                + ",\"type\":" + quote(type) + "}";
    }

    /** 发布消息：{@code {"op":"publish","topic":...,"msg":...}}。 */
    public static String publish(String topic, String msgJson) {
        return "{\"op\":\"" + TobotConstants.OP_PUBLISH + "\",\"topic\":" + quote(topic)
                + ",\"msg\":" + msgJson + "}";
    }

    /**
     * geometry_msgs/Twist 消息体。手动遥控只用到线速度 x 与角速度 z。
     *
     * @param linearX  前进速度，单位 m/s（负值后退）
     * @param angularZ 转向角速度，单位 rad/s（正值左转）
     */
    public static String twistMsg(double linearX, double angularZ) {
        return "{\"linear\":{\"x\":" + num(linearX) + ",\"y\":0,\"z\":0},"
                + "\"angular\":{\"x\":0,\"y\":0,\"z\":" + num(angularZ) + "}}";
    }

    // ------------------------------------------------------------------ 工具

    /** 输出一个合法的 JSON 字符串字面量（含双引号）。 */
    static String quote(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format(Locale.US, "\\u%04x", (int) c));
                    } else {
                        // 中文等非 ASCII 原样保留，WebSocket 层按 UTF-8 发送
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    /**
     * 输出 JSON 数字。整数值不带小数点（{@code 999999} 而不是 {@code 999999.0}），
     * 这样取消导航报文与官方文档样例逐字符一致。
     */
    static String num(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) {
            return "0";
        }
        if (v == Math.rint(v) && Math.abs(v) < 1e15) {
            return Long.toString((long) v);
        }
        return Double.toString(v);
    }
}
