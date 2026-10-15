package com.tobot.slam3d.model;

import com.tobot.slam3d.core.Pose2D;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 底盘状态的只读快照，供界面渲染使用。
 *
 * <p>界面不直接持有可变状态：{@code ChassisRepository} 在收到任意报文后
 * 生成一份新的快照丢给 UI，避免多线程读写同一份集合。
 */
public final class ChassisSnapshot {

    /** 是否已连接 rosbridge。 */
    public final boolean connected;
    /** 当前位姿；未收到 /fast_lio_localization 前为 null。 */
    public final Pose2D pose;
    /** 最新一次全局路径点（底盘只推约 30 秒，之后沿用缓存）。 */
    public final List<Pose2D> path;
    /** 地图列表。 */
    public final List<MapInfo> maps;
    /** 电量与充电状态。 */
    public final BatteryState battery;
    /** /ebot_goal_status_local_planner 最近一次的 data[0]==1。 */
    public final boolean arrived;
    /** 是否已下发过导航且尚未到达/取消（仅用于界面文案，不来自协议）。 */
    public final boolean navigating;
    /** 最近一次状态消息，显示在「最新信息」区域。 */
    public final String lastMessage;

    public ChassisSnapshot(boolean connected, Pose2D pose, List<Pose2D> path, List<MapInfo> maps,
                           BatteryState battery, boolean arrived, boolean navigating, String lastMessage) {
        this.connected = connected;
        this.pose = pose;
        this.path = Collections.unmodifiableList(
                path == null ? new ArrayList<Pose2D>() : new ArrayList<Pose2D>(path));
        this.maps = Collections.unmodifiableList(
                maps == null ? new ArrayList<MapInfo>() : new ArrayList<MapInfo>(maps));
        this.battery = battery == null ? BatteryState.UNKNOWN : battery;
        this.arrived = arrived;
        this.navigating = navigating;
        this.lastMessage = lastMessage == null ? "" : lastMessage;
    }
}
