package com.tobot.slam3d.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 一张已保存的地图及其目标点（对应 /map_list_kitty 里 maps[] 的元素）。
 */
public final class MapInfo {

    /** 地图显示名；同时也是 save/select 的 filepath 值与 delete 的 map_name 值。 */
    public final String mapName;
    /** 地图文件路径，协议标注为「内部用」，**不要**把它当 filepath 传给服务。 */
    public final String mapPath;
    private final List<Goal> goals;

    public MapInfo(String mapName, String mapPath, List<Goal> goals) {
        this.mapName = mapName == null ? "" : mapName;
        this.mapPath = mapPath == null ? "" : mapPath;
        this.goals = Collections.unmodifiableList(
                goals == null ? new ArrayList<Goal>() : new ArrayList<Goal>(goals));
    }

    public List<Goal> goals() {
        return goals;
    }

    /** 按名称查找目标点，找不到返回 null。 */
    public Goal findGoal(String goalName) {
        if (goalName == null) {
            return null;
        }
        for (Goal g : goals) {
            if (goalName.equals(g.name)) {
                return g;
            }
        }
        return null;
    }

    /** 供 Spinner 直接显示。 */
    @Override
    public String toString() {
        return mapName;
    }
}
