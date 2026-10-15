package com.tobot.slam3d.net;

import com.tobot.slam3d.core.Pose2D;
import com.tobot.slam3d.core.TobotConstants;
import com.tobot.slam3d.model.BatteryState;
import com.tobot.slam3d.model.Goal;
import com.tobot.slam3d.model.MapInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 把底盘推来的 rosbridge 报文解析成模型对象。
 *
 * <p>全部使用 {@code opt*} 系列方法而不是 {@code get*}：底盘版本或场景不同可能缺字段，
 * 缺字段时应当降级而不是抛异常导致整个连接回调崩掉。
 */
public final class RosbridgeParser {

    private RosbridgeParser() {
    }

    /**
     * 解析 /fast_lio_localization（nav_msgs/Odometry）。
     * 层级：{@code pose.pose.position.{x,y,z}} 与 {@code pose.pose.orientation.{x,y,z,w}}。
     *
     * @return 位姿；报文结构不符时返回 null
     */
    public static Pose2D parsePose(JSONObject msg) {
        if (msg == null) {
            return null;
        }
        JSONObject pose = msg.optJSONObject("pose");
        if (pose == null) {
            return null;
        }
        JSONObject inner = pose.optJSONObject("pose");
        if (inner == null) {
            return null;
        }
        JSONObject position = inner.optJSONObject("position");
        if (position == null) {
            return null;
        }
        double x = position.optDouble("x", 0d);
        // 底盘 z 恒为 0，这里读出来只为对齐协议，不参与计算
        double y = position.optDouble("y", 0d);
        double yaw = 0d;
        JSONObject orientation = inner.optJSONObject("orientation");
        if (orientation != null) {
            yaw = Pose2D.yawFromQuaternion(
                    orientation.optDouble("x", 0d),
                    orientation.optDouble("y", 0d),
                    orientation.optDouble("z", 0d),
                    orientation.optDouble("w", 1d));
        }
        return new Pose2D(x, y, yaw);
    }

    /**
     * 解析 /aft_pgo_path（nav_msgs/Path）。
     * 层级：{@code poses[].pose.position.{x,y}}。
     * 底盘只在导航启动后约 30 秒内推送，调用方需要缓存结果。
     */
    public static List<Pose2D> parsePath(JSONObject msg) {
        List<Pose2D> out = new ArrayList<Pose2D>();
        if (msg == null) {
            return out;
        }
        JSONArray poses = msg.optJSONArray(TobotConstants.FIELD_POSES);
        if (poses == null) {
            return out;
        }
        for (int i = 0; i < poses.length(); i++) {
            JSONObject ps = poses.optJSONObject(i);
            if (ps == null) {
                continue;
            }
            JSONObject pose = ps.optJSONObject("pose");
            if (pose == null) {
                continue;
            }
            JSONObject position = pose.optJSONObject("position");
            if (position == null) {
                continue;
            }
            out.add(new Pose2D(position.optDouble("x", 0d), position.optDouble("y", 0d), 0d));
        }
        return out;
    }

    /**
     * 解析 /map_list_kitty（kitty_runtime_manager/MapList）。
     * 层级：{@code maps[].{map_name,map_path,goals[].{name,x,y,theta}}}。
     */
    public static List<MapInfo> parseMapList(JSONObject msg) {
        List<MapInfo> out = new ArrayList<MapInfo>();
        if (msg == null) {
            return out;
        }
        JSONArray maps = msg.optJSONArray(TobotConstants.FIELD_MAPS);
        if (maps == null) {
            return out;
        }
        for (int i = 0; i < maps.length(); i++) {
            JSONObject m = maps.optJSONObject(i);
            if (m == null) {
                continue;
            }
            String mapName = m.optString(TobotConstants.FIELD_MAP_NAME, "");
            String mapPath = m.optString(TobotConstants.FIELD_MAP_PATH, "");
            List<Goal> goals = new ArrayList<Goal>();
            JSONArray arr = m.optJSONArray(TobotConstants.FIELD_GOALS);
            if (arr != null) {
                for (int j = 0; j < arr.length(); j++) {
                    JSONObject g = arr.optJSONObject(j);
                    if (g == null) {
                        continue;
                    }
                    goals.add(new Goal(
                            g.optString(TobotConstants.FIELD_NAME, ""),
                            g.optDouble("x", 0d),
                            g.optDouble("y", 0d),
                            g.optDouble(TobotConstants.FIELD_THETA, 0d)));
                }
            }
            out.add(new MapInfo(mapName, mapPath, goals));
        }
        return out;
    }

    /**
     * 解析 /ebot_goal_status_local_planner（std_msgs/Float64MultiArray）。
     *
     * @return {@code data[0] == 1} 时为 true（到达）
     */
    public static boolean parseArrived(JSONObject msg) {
        double[] data = firstTwoOfData(msg);
        return data != null && ((int) data[0]) == TobotConstants.GOAL_STATUS_ARRIVED;
    }

    /**
     * 解析 /ebot_work_state（std_msgs/Float64MultiArray）。
     * {@code data[0]}：1=充电中，2=未充电；{@code data[1]}：电量百分比。
     *
     * @return 电量状态；报文结构不符时返回 {@link BatteryState#UNKNOWN}
     */
    public static BatteryState parseBattery(JSONObject msg) {
        double[] data = firstTwoOfData(msg);
        if (data == null) {
            return BatteryState.UNKNOWN;
        }
        return BatteryState.fromData(data[0], data[1]);
    }

    /** 取 Float64MultiArray 的 data[0] 与 data[1]；缺 data 时返回 null。 */
    private static double[] firstTwoOfData(JSONObject msg) {
        if (msg == null) {
            return null;
        }
        JSONArray data = msg.optJSONArray(TobotConstants.FIELD_DATA);
        if (data == null || data.length() == 0) {
            return null;
        }
        double first = data.optDouble(0, 0d);
        double second = data.length() > 1 ? data.optDouble(1, -1d) : -1d;
        return new double[]{first, second};
    }
}
