package com.tobot.slam3d.model;

import java.util.Locale;

/**
 * 一个已保存的目标点（对应 /map_list_kitty 里 maps[].goals[] 的元素）。
 *
 * <p>字段名与协议一致：name / x / y / theta，其中 theta 单位是**弧度**。
 */
public final class Goal {

    public final String name;
    public final double x;
    public final double y;
    /** 朝向，单位弧度。 */
    public final double theta;

    public Goal(String name, double x, double y, double theta) {
        this.name = name == null ? "" : name;
        this.x = x;
        this.y = y;
        this.theta = theta;
    }

    /** 供 Spinner 直接显示。 */
    @Override
    public String toString() {
        return name;
    }

    /** 形如 {@code Reception (1.00, 2.00, 28.6°)}，用于详情展示。 */
    public String describe() {
        return String.format(Locale.US, "%s (%.2f, %.2f, %.1f\u00b0)",
                name, x, y, Math.toDegrees(theta));
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof Goal)) {
            return false;
        }
        Goal other = (Goal) o;
        return name.equals(other.name);
    }

    @Override
    public int hashCode() {
        return name.hashCode();
    }
}
