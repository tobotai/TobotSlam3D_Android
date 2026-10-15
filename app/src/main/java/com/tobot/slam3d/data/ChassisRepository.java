package com.tobot.slam3d.data;

import android.os.Handler;
import android.os.Looper;

import com.tobot.slam3d.core.Pose2D;
import com.tobot.slam3d.core.TobotConstants;
import com.tobot.slam3d.model.BatteryState;
import com.tobot.slam3d.model.ChassisSnapshot;
import com.tobot.slam3d.model.MapInfo;
import com.tobot.slam3d.net.RosbridgeClient;
import com.tobot.slam3d.net.RosbridgeMessages;
import com.tobot.slam3d.net.RosbridgeParser;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 底盘状态与业务编排。
 *
 * <p>把「协议报文」翻译成「界面能直接用的状态」，并把 Web 面板上的操作
 * （建图 / 存图 / 选图 / 加点 / 删点 / 导航 / 取消 / 回桩）封装成方法。
 *
 * <p>状态只在主线程读写：{@link RosbridgeClient} 已把所有回调切到主线程，
 * {@link #snapshot()} 返回的是不可变副本。
 */
public class ChassisRepository implements RosbridgeClient.Listener {

    /** 界面观察者。 */
    public interface Observer {
        /** 状态有更新，参数是新的只读快照。 */
        void onSnapshot(ChassisSnapshot snapshot);

        /** 一行日志，显示到「最新信息」。 */
        void onLog(String line);
    }

    /**
     * 导航超时提醒时间。官方文档没有定义导航失败/卡住的上报方式，
     * 这里只做「到点给个提示」，不改变任何协议行为。
     */
    private static final long NAV_WATCHDOG_MS = 180000L;

    private final RosbridgeClient client = new RosbridgeClient();
    private final List<Observer> observers = new CopyOnWriteArrayList<Observer>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // ---------------------------------------------------------------- 可变状态

    private boolean connected;
    private Pose2D pose;
    private List<Pose2D> path = new ArrayList<Pose2D>();
    private List<MapInfo> maps = new ArrayList<MapInfo>();
    private BatteryState battery = BatteryState.UNKNOWN;
    private boolean arrived;
    private boolean navigating;
    private String lastMessage = "";
    /** 手动遥控话题；为 null 表示尚未配置。 */
    private String cmdVelTopic;

    private final Runnable navWatchdog = new Runnable() {
        @Override
        public void run() {
            if (navigating && !arrived) {
                setMessage("\u5bfc\u822a\u5df2\u8d85\u8fc7 "
                        + (NAV_WATCHDOG_MS / 60000) + " \u5206\u949f\u4ecd\u672a\u6536\u5230\u5230\u8fbe\u72b6\u6001"
                        + "\uff0c\u53ef\u5c1d\u8bd5\u53d6\u6d88\u540e\u91cd\u65b0\u5bfc\u822a");
            }
        }
    };

    public ChassisRepository() {
        client.setListener(this);
    }

    // ---------------------------------------------------------------- 观察者

    public void addObserver(Observer o) {
        if (o != null && !observers.contains(o)) {
            observers.add(o);
        }
    }

    public void removeObserver(Observer o) {
        observers.remove(o);
    }

    private void notifyChanged() {
        ChassisSnapshot s = snapshot();
        for (Observer o : observers) {
            o.onSnapshot(s);
        }
    }

    private void setMessage(String msg) {
        this.lastMessage = msg == null ? "" : msg;
        notifyChanged();
    }

    /** 当前状态的只读快照。 */
    public ChassisSnapshot snapshot() {
        return new ChassisSnapshot(connected, pose, path, maps, battery, arrived, navigating, lastMessage);
    }

    public boolean isConnected() {
        return connected;
    }

    // ---------------------------------------------------------------- 连接

    /** 连接前先把 5 个订阅登记好，连接建立后客户端会自动补发。 */
    public void connect(String wsUrl) {
        client.subscribe(TobotConstants.TOPIC_POSE, TobotConstants.TYPE_POSE);
        client.subscribe(TobotConstants.TOPIC_PATH, TobotConstants.TYPE_PATH);
        client.subscribe(TobotConstants.TOPIC_MAP_LIST, TobotConstants.TYPE_MAP_LIST);
        client.subscribe(TobotConstants.TOPIC_GOAL_STATUS, TobotConstants.TYPE_GOAL_STATUS);
        client.subscribe(TobotConstants.TOPIC_WORK_STATE, TobotConstants.TYPE_WORK_STATE);
        client.connect(wsUrl);
    }

    public void disconnect() {
        mainHandler.removeCallbacks(navWatchdog);
        client.disconnect();
    }

    /**
     * 重新请求地图列表。
     *
     * <p>协议里没有「查询地图列表」的服务，只能重复订阅 {@code /map_list_kitty}。
     * 原文未说明增删改后底盘是否会自动重推，因此每次地图/目标点变更成功后
     * 主动重订一次做兜底。
     */
    public void requestMapList() {
        client.subscribe(TobotConstants.TOPIC_MAP_LIST, TobotConstants.TYPE_MAP_LIST);
    }

    // ---------------------------------------------------------------- 业务动作

    /** 开始建图。 */
    public void startMapping() {
        client.callService(TobotConstants.SVC_START_MAPPING, RosbridgeMessages.emptyArgs());
    }

    /**
     * 保存当前地图。
     *
     * @param mapName 只传地图名，不要带路径（带路径底盘会判失败）
     */
    public void saveMap(String mapName) {
        client.callService(TobotConstants.SVC_SAVE_MAP, RosbridgeMessages.filepathArgs(mapName));
    }

    /** 选择地图并启动导航。 */
    public void selectMapAndStart(String mapName) {
        client.callService(TobotConstants.SVC_SELECT_MAP, RosbridgeMessages.filepathArgs(mapName));
    }

    /** 删除地图。 */
    public void deleteMap(String mapName) {
        client.callService(TobotConstants.SVC_DELETE_MAP, RosbridgeMessages.mapNameArgs(mapName));
    }

    /** 回桩充电。注意 success 只代表流程已启动，是否充上电要看电量状态。 */
    public void docking() {
        client.callService(TobotConstants.SVC_DOCKING, RosbridgeMessages.emptyArgs());
    }

    /** 导航到指定坐标（z 恒为 0）。 */
    public void navigateTo(double x, double y) {
        navigating = true;
        arrived = false;
        client.callService(TobotConstants.SVC_NAVIGATE, RosbridgeMessages.navigateArgs(x, y));
        mainHandler.removeCallbacks(navWatchdog);
        mainHandler.postDelayed(navWatchdog, NAV_WATCHDOG_MS);
        notifyChanged();
    }

    /** 取消导航：向同一个服务发魔数坐标 999999 / 888888。 */
    public void cancelNavigation() {
        navigating = false;
        arrived = false;
        mainHandler.removeCallbacks(navWatchdog);
        client.callService(TobotConstants.SVC_NAVIGATE, RosbridgeMessages.cancelNavigateArgs());
        notifyChanged();
    }

    /**
     * 添加目标点。
     *
     * @param theta 朝向，单位弧度
     */
    public void addGoal(String mapName, String goalName, double x, double y, double theta) {
        client.callService(TobotConstants.SVC_ADD_GOAL,
                RosbridgeMessages.addGoalArgs(mapName, goalName, x, y, theta));
    }

    /** 删除目标点。 */
    public void deleteGoal(String mapName, String goalName) {
        client.callService(TobotConstants.SVC_DELETE_GOAL,
                RosbridgeMessages.deleteGoalArgs(mapName, goalName));
    }

    // ---------------------------------------------------------------- 手动遥控

    /**
     * 设置手动遥控话题并在已连接时立即宣告。
     * 话题名可在设置界面修改，用于现场实测出真实速度话题后免改代码。
     */
    public void setCmdVelTopic(String topic) {
        this.cmdVelTopic = topic;
        if (client.isConnected() && topic != null) {
            advertiseCmdVel(topic);
        }
    }

    /**
     * 宣告手动遥控话题。必须在 publish 之前调用；重连后会自动重新宣告。
     *
     * <p>⚠️ 该话题不在官方 SDK 文档的 5 个 Topic 之内，属于按 ROS 通用约定实现的
     * 补充能力，话题名可在设置里改。详见 {@link TobotConstants#DEFAULT_CMD_VEL_TOPIC}。
     */
    public void advertiseCmdVel(String topic) {
        if (topic == null) {
            return;
        }
        client.sendRaw(RosbridgeMessages.advertise(topic, TobotConstants.TYPE_TWIST));
    }

    /**
     * 下发一次速度指令。
     *
     * @param linearX  前进速度 m/s
     * @param angularZ 角速度 rad/s
     */
    public void publishTwist(double linearX, double angularZ) {
        if (cmdVelTopic == null) {
            return;
        }
        client.sendRaw(RosbridgeMessages.publish(cmdVelTopic, RosbridgeMessages.twistMsg(linearX, angularZ)));
    }

    /** 松手 / 退出时务必归零，否则底盘会继续按最后一次速度行驶。 */
    public void stopMotion() {
        if (cmdVelTopic == null) {
            return;
        }
        // 连发两次：避免单条报文丢失导致底盘不停
        client.sendRaw(RosbridgeMessages.publish(cmdVelTopic, RosbridgeMessages.twistMsg(0d, 0d)));
        client.sendRaw(RosbridgeMessages.publish(cmdVelTopic, RosbridgeMessages.twistMsg(0d, 0d)));
    }

    // ---------------------------------------------------------------- 客户端回调

    @Override
    public void onConnected() {
        connected = true;
        // 重连后必须重新宣告手动遥控话题，否则 publish 会被 rosbridge 丢弃
        if (cmdVelTopic != null) {
            advertiseCmdVel(cmdVelTopic);
        }
        setMessage("Connected!");
    }

    @Override
    public void onDisconnected(String reason) {
        connected = false;
        navigating = false;
        mainHandler.removeCallbacks(navWatchdog);
        setMessage(reason == null ? "\u5df2\u65ad\u5f00" : "\u8fde\u63a5\u4e2d\u65ad\uff1a" + reason);
    }

    @Override
    public void onPublished(String topic, JSONObject msg) {
        if (TobotConstants.TOPIC_POSE.equals(topic)) {
            Pose2D p = RosbridgeParser.parsePose(msg);
            if (p != null) {
                pose = p;
            }
        } else if (TobotConstants.TOPIC_PATH.equals(topic)) {
            List<Pose2D> pts = RosbridgeParser.parsePath(msg);
            // 底盘只在导航后约 30 秒内推送，空数组也不应该把已有路径清掉
            if (!pts.isEmpty()) {
                path = pts;
            }
        } else if (TobotConstants.TOPIC_MAP_LIST.equals(topic)) {
            maps = RosbridgeParser.parseMapList(msg);
        } else if (TobotConstants.TOPIC_GOAL_STATUS.equals(topic)) {
            boolean now = RosbridgeParser.parseArrived(msg);
            if (now) {
                arrived = true;
                navigating = false;
                mainHandler.removeCallbacks(navWatchdog);
                lastMessage = "\u5df2\u5230\u8fbe\u76ee\u6807\u70b9";
            }
        } else if (TobotConstants.TOPIC_WORK_STATE.equals(topic)) {
            battery = RosbridgeParser.parseBattery(msg);
        }
        notifyChanged();
    }

    @Override
    public void onServiceResponse(String service, JSONObject values, boolean result) {
        boolean success = values.optBoolean(TobotConstants.KEY_SUCCESS, result);
        String message = values.optString(TobotConstants.KEY_MESSAGE, "");
        StringBuilder sb = new StringBuilder();
        sb.append(shortName(service)).append(success ? " \u6210\u529f" : " \u5931\u8d25");
        if (!message.isEmpty()) {
            sb.append("\uff1a").append(message);
        }
        lastMessage = sb.toString();

        if (success) {
            if (TobotConstants.SVC_START_MAPPING.equals(service)) {
                // 建图中：清掉上一轮的路径，避免旧路径干扰
                path = new ArrayList<Pose2D>();
            } else if (TobotConstants.SVC_SAVE_MAP.equals(service)
                    || TobotConstants.SVC_DELETE_MAP.equals(service)
                    || TobotConstants.SVC_ADD_GOAL.equals(service)
                    || TobotConstants.SVC_DELETE_GOAL.equals(service)) {
                // 地图/目标点变了，重订一次地图列表兜底
                requestMapList();
            } else if (TobotConstants.SVC_DOCKING.equals(service)) {
                // 是否真的充上电由 /ebot_work_state 决定，这里只提示流程已启动
                lastMessage = lastMessage + "\uff08\u662f\u5426\u5145\u4e0a\u7535\u8bf7\u770b\u7535\u91cf\u72b6\u6001\uff09";
            }
        }
        notifyChanged();
    }

    @Override
    public void onLog(String line) {
        for (Observer o : observers) {
            o.onLog(line);
        }
    }

    private static String shortName(String service) {
        if (service == null) {
            return "";
        }
        return service.startsWith("/") ? service.substring(1) : service;
    }
}
