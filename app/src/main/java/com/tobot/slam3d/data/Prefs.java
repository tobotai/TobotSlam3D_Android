package com.tobot.slam3d.data;

import android.content.Context;
import android.content.SharedPreferences;

import com.tobot.slam3d.core.TobotConstants;

import java.util.Locale;

/**
 * 本地配置：底盘地址与手动遥控速度上限。
 *
 * <p>底盘 IP 现场各不相同，必须可配置；速度上限对应 Web 面板的
 * 「最大线速度」（默认 0.2）与「最大角速度」（默认 0.5）。
 */
public final class Prefs {

    private static final String FILE = "tobot_slam3d_prefs";
    private static final String KEY_HOST = "host";
    private static final String KEY_PORT = "port";
    private static final String KEY_MAX_LINEAR = "max_linear";
    private static final String KEY_MAX_ANGULAR = "max_angular";
    private static final String KEY_CMD_VEL_TOPIC = "cmd_vel_topic";

    private final SharedPreferences sp;

    public Prefs(Context context) {
        this.sp = context.getApplicationContext()
                .getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public String host() {
        return sp.getString(KEY_HOST, TobotConstants.DEFAULT_HOST);
    }

    public int port() {
        return sp.getInt(KEY_PORT, TobotConstants.DEFAULT_WS_PORT);
    }

    public void setEndpoint(String host, int port) {
        sp.edit().putString(KEY_HOST, host).putInt(KEY_PORT, port).apply();
    }

    public float maxLinear() {
        return sp.getFloat(KEY_MAX_LINEAR, TobotConstants.DEFAULT_MAX_LINEAR);
    }

    public void setMaxLinear(float v) {
        sp.edit().putFloat(KEY_MAX_LINEAR, v).apply();
    }

    public float maxAngular() {
        return sp.getFloat(KEY_MAX_ANGULAR, TobotConstants.DEFAULT_MAX_ANGULAR);
    }

    public void setMaxAngular(float v) {
        sp.edit().putFloat(KEY_MAX_ANGULAR, v).apply();
    }

    /**
     * 手动遥控速度话题名。
     *
     * <p>官方 SDK 文档没有公开速度接口，所以话题名做成可配置的，
     * 现场实测出真实话题后可以不必改代码。
     */
    public String cmdVelTopic() {
        return sp.getString(KEY_CMD_VEL_TOPIC, TobotConstants.DEFAULT_CMD_VEL_TOPIC);
    }

    public void setCmdVelTopic(String topic) {
        String t = topic == null ? "" : topic.trim();
        if (t.isEmpty()) {
            t = TobotConstants.DEFAULT_CMD_VEL_TOPIC;
        }
        if (!t.startsWith("/")) {
            t = "/" + t;
        }
        sp.edit().putString(KEY_CMD_VEL_TOPIC, t).apply();
    }

    /** 拼出 rosbridge 地址，形如 {@code ws://192.168.1.151:9090}。 */
    public String webSocketUrl() {
        return String.format(Locale.US, "ws://%s:%d", host(), port());
    }

    /**
     * 解析用户输入的服务地址，写入配置。
     *
     * <p>容忍这几种写法：{@code ws://192.168.1.151:9090}、
     * {@code 192.168.1.151:9090}、{@code 192.168.1.151}（端口用默认值）。
     *
     * @return 解析后的地址；无法解析时返回 null（调用方应提示用户）
     */
    public String applyUrl(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim();
        if (s.isEmpty()) {
            return null;
        }
        if (s.startsWith("ws://")) {
            s = s.substring(5);
        } else if (s.startsWith("wss://")) {
            s = s.substring(6);
        } else if (s.startsWith("http://")) {
            s = s.substring(7);
        } else if (s.startsWith("https://")) {
            s = s.substring(8);
        }
        // 去掉可能的路径部分
        int slash = s.indexOf('/');
        if (slash >= 0) {
            s = s.substring(0, slash);
        }
        if (s.isEmpty()) {
            return null;
        }
        String host = s;
        int port = TobotConstants.DEFAULT_WS_PORT;
        int colon = s.lastIndexOf(':');
        if (colon > 0 && colon < s.length() - 1) {
            String portPart = s.substring(colon + 1);
            try {
                int parsed = Integer.parseInt(portPart);
                if (parsed <= 0 || parsed > 65535) {
                    return null;
                }
                port = parsed;
                host = s.substring(0, colon);
            } catch (NumberFormatException e) {
                return null;
            }
        }
        if (host.isEmpty()) {
            return null;
        }
        setEndpoint(host, port);
        return webSocketUrl();
    }
}
