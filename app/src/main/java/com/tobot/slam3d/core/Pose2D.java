package com.tobot.slam3d.core;

import java.util.Locale;

/**
 * 平面位姿：x、y 单位米，yaw 单位弧度。
 *
 * 底盘在 z 方向恒为 0（见 {@link TobotConstants#Z_ALWAYS_ZERO}），
 * 所以整个应用只需要二维位姿，四元数只在进出协议时转换。
 */
public final class Pose2D {

    public static final Pose2D ZERO = new Pose2D(0d, 0d, 0d);

    public final double x;
    public final double y;
    /** 朝向，单位弧度。 */
    public final double yaw;

    public Pose2D(double x, double y, double yaw) {
        this.x = x;
        this.y = y;
        this.yaw = yaw;
    }

    /**
     * 四元数 → yaw，单位弧度。采用 SDK 文档给出的原文公式：
     * <pre>yaw = atan2(2*(w*z + x*y), 1 - 2*(z*z + y*y))</pre>
     * 底盘只绕 z 轴旋转，因此这个简化公式是精确的。
     */
    public static double yawFromQuaternion(double qx, double qy, double qz, double qw) {
        return Math.atan2(2d * (qw * qz + qx * qy), 1d - 2d * (qz * qz + qy * qy));
    }

    /**
     * yaw → 绕 z 轴四元数。返回 {@code [x, y, z, w]}：
     * {@code z = sin(yaw/2), w = cos(yaw/2), x = y = 0}。
     * （SDK 文档只给了反向公式，这里是标准换算。）
     */
    public static double[] quaternionFromYaw(double yaw) {
        return new double[]{0d, 0d, Math.sin(yaw / 2d), Math.cos(yaw / 2d)};
    }

    public static double radToDeg(double rad) {
        return rad * 180d / Math.PI;
    }

    public static double degToRad(double deg) {
        return deg * Math.PI / 180d;
    }

    /** 归一化到 (-180, 180]，单位度。 */
    public static double normalizeDegrees(double deg) {
        double d = deg % 360d;
        if (d > 180d) {
            d -= 360d;
        }
        if (d <= -180d) {
            d += 360d;
        }
        return d;
    }

    public static double distance(double x1, double y1, double x2, double y2) {
        double dx = x2 - x1;
        double dy = y2 - y1;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /** 形如 {@code (1.23, 4.56, -30.0°)}，用于状态栏显示。 */
    @Override
    public String toString() {
        return "(" + fmt(x) + ", " + fmt(y) + ", " + fmt(radToDeg(yaw)) + "\u00b0)";
    }

    private static String fmt(double v) {
        return String.format(Locale.US, "%.2f", v);
    }
}
