package com.tobot.slam3d.net;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.tobot.slam3d.core.TobotConstants;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * rosbridge WebSocket 客户端。
 *
 * <p>只做四件事：连接、订阅、调用服务、把收到的报文派发给 {@link Listener}。
 * 所有回调都切回主线程，界面代码不必再关心线程。
 *
 * <p>关于分片/大报文：OkHttp 会在 {@code onMessage} 之前把 WebSocket 分帧组装成完整消息，
 * 因此 {@code /aft_pgo_path} 这类较大报文不需要自己做粘包/分片拼接。
 *
 * <p>关于心跳与重连：官方文档**没有**规定超时、心跳与重连策略，这里的
 * {@code pingInterval} 与指数退避重连属于工程兜底实现，可按现场网络情况调整。
 */
public class RosbridgeClient {

    private static final String TAG = "RosbridgeClient";

    /** 事件回调，全部在主线程触发。 */
    public interface Listener {
        /** 连接建立（自动重连成功也会回调）。 */
        void onConnected();

        /** 连接断开。{@code reason} 为 null 表示是主动断开。 */
        void onDisconnected(String reason);

        /** 收到 op==publish。 */
        void onPublished(String topic, JSONObject msg);

        /** 收到 op==service_response。 */
        void onServiceResponse(String service, JSONObject values, boolean result);

        /** 供界面「最新信息」区域展示的一行日志。 */
        void onLog(String line);
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final OkHttpClient httpClient;
    /** 已登记的订阅，重连后自动重放（topic -> type）。 */
    private final Map<String, String> subscriptions = new LinkedHashMap<String, String>();

    private Listener listener;
    private WebSocket socket;
    private String url;
    private boolean connected;
    private boolean manualClose;
    private int reconnectAttempts;
    private boolean everConnected;

    public RosbridgeClient() {
        this.httpClient = new OkHttpClient.Builder()
                // 心跳：ws ping，原文未规定周期，20s 是常用兜底值
                .pingInterval(20, TimeUnit.SECONDS)
                // WebSocket 长连接，禁用读超时
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .connectTimeout(8, TimeUnit.SECONDS)
                .build();
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public boolean isConnected() {
        return connected;
    }

    /** 是否曾经成功连接过（用于区分「从未连上」与「连上后掉线」）。 */
    public boolean hasEverConnected() {
        return everConnected;
    }

    /** 当前使用的地址，形如 {@code ws://192.168.1.151:9090}。 */
    public String getUrl() {
        return url;
    }

    // ------------------------------------------------------------------ 连接

    /** 连接指定地址；重复调用会先断开旧连接。 */
    public void connect(String wsUrl) {
        this.url = wsUrl;
        this.manualClose = false;
        this.reconnectAttempts = 0;
        openSocket();
    }

    private void openSocket() {
        if (url == null) {
            return;
        }
        closeSocketQuietly();
        log("\u6b63\u5728\u8fde\u63a5 " + url + " \u2026");
        Request request = new Request.Builder().url(url).build();
        socket = httpClient.newWebSocket(request, new InternalListener());
    }

    /** 主动断开，不再自动重连。 */
    public void disconnect() {
        manualClose = true;
        connected = false;
        closeSocketQuietly();
        postDisconnected(null);
        log("\u5df2\u65ad\u5f00\u8fde\u63a5");
    }

    private void closeSocketQuietly() {
        WebSocket s = socket;
        socket = null;
        if (s != null) {
            try {
                s.close(1000, "client closing");
            } catch (Exception ignored) {
                // 关闭失败无需处理，底层连接会被回收
            }
        }
    }

    // ------------------------------------------------------------------ 发送

    /**
     * 登记订阅并在已连接时立即发送。重连后会自动重新发送全部订阅，
     * 因为底盘不保证记住上一次会话的订阅关系。
     */
    public void subscribe(String topic, String type) {
        subscriptions.put(topic, type);
        if (connected) {
            sendRaw(RosbridgeMessages.subscribe(topic, type));
        }
    }

    /** 调用服务。{@code argsJson} 用 {@link RosbridgeMessages} 里的方法构造。 */
    public void callService(String service, String argsJson) {
        sendRaw(RosbridgeMessages.callService(service, argsJson));
    }

    public void sendRaw(String text) {
        WebSocket s = socket;
        if (s == null || !connected) {
            log("\u672a\u8fde\u63a5\uff0c\u653e\u5f03\u53d1\u9001\uff1a" + abbreviate(text));
            return;
        }
        boolean ok = s.send(text);
        if (!ok) {
            log("\u53d1\u9001\u5931\u8d25\uff1a" + abbreviate(text));
        }
    }

    // ------------------------------------------------------------------ 内部

    private class InternalListener extends WebSocketListener {

        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            connected = true;
            everConnected = true;
            reconnectAttempts = 0;
            log("\u8fde\u63a5\u6210\u529f");
            // 重连后必须先补发订阅，再通知界面，避免界面刷新时拿不到数据
            for (Map.Entry<String, String> e : subscriptions.entrySet()) {
                webSocket.send(RosbridgeMessages.subscribe(e.getKey(), e.getValue()));
            }
            postConnected();
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            handleIncoming(text);
        }

        @Override
        public void onMessage(WebSocket webSocket, ByteString bytes) {
            // 默认走 JSON 文本帧；若底盘侧配置了二进制编码则按 UTF-8 尝试解析
            handleIncoming(bytes.utf8());
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            webSocket.close(1000, null);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            connected = false;
            log("\u8fde\u63a5\u5df2\u5173\u95ed\uff08code=" + code + "\uff09");
            scheduleReconnectIfNeeded(reason);
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            connected = false;
            String msg = t == null ? "unknown" : t.getMessage();
            log("\u8fde\u63a5\u5f02\u5e38\uff1a" + msg);
            scheduleReconnectIfNeeded(msg);
        }
    }

    private void handleIncoming(String text) {
        if (text == null || text.isEmpty()) {
            return;
        }
        try {
            JSONObject json = new JSONObject(text);
            String op = json.optString(TobotConstants.OP, "");
            if (TobotConstants.OP_PUBLISH.equals(op)) {
                String topic = json.optString(TobotConstants.KEY_TOPIC, "");
                JSONObject msg = json.optJSONObject(TobotConstants.KEY_MSG);
                if (msg != null) {
                    postPublished(topic, msg);
                }
            } else if (TobotConstants.OP_SERVICE_RESPONSE.equals(op)) {
                String service = json.optString(TobotConstants.KEY_SERVICE, "");
                JSONObject values = json.optJSONObject(TobotConstants.KEY_VALUES);
                boolean result = json.optBoolean(TobotConstants.KEY_RESULT, true);
                postServiceResponse(service, values == null ? new JSONObject() : values, result);
            }
            // 其它 op（如 status / png / fragment）本轮协议用不到，忽略即可
        } catch (Exception e) {
            // 单条报文解析失败不应影响连接
            log("\u62a5\u6587\u89e3\u6790\u5931\u8d25\uff1a" + e.getMessage());
            Log.w(TAG, "bad message: " + abbreviate(text), e);
        }
    }

    private void scheduleReconnectIfNeeded(String reason) {
        final boolean willRetry = !manualClose && reconnectAttempts < TobotConstants.MAX_RECONNECT_ATTEMPTS;
        postDisconnected(reason);
        if (!willRetry) {
            if (!manualClose) {
                log("\u91cd\u8fde\u5df2\u8fbe\u4e0a\u9650\uff08" + TobotConstants.MAX_RECONNECT_ATTEMPTS + " \u6b21\uff09\uff0c\u8bf7\u624b\u52a8\u91cd\u8fde");
            }
            return;
        }
        reconnectAttempts++;
        long delay = TobotConstants.RECONNECT_BASE_DELAY_MS * reconnectAttempts;
        log("\u5c06\u5728 " + (delay / 1000) + "s \u540e\u91cd\u8fde\uff08\u7b2c " + reconnectAttempts + " \u6b21\uff09");
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!manualClose) {
                    openSocket();
                }
            }
        }, delay);
    }

    // ------------------------------------------------------------------ 主线程派发

    private void post(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            r.run();
        } else {
            mainHandler.post(r);
        }
    }

    private void postConnected() {
        final Listener l = listener;
        if (l == null) {
            return;
        }
        post(new Runnable() {
            @Override
            public void run() {
                l.onConnected();
            }
        });
    }

    private void postDisconnected(final String reason) {
        final Listener l = listener;
        if (l == null) {
            return;
        }
        post(new Runnable() {
            @Override
            public void run() {
                l.onDisconnected(reason);
            }
        });
    }

    private void postPublished(final String topic, final JSONObject msg) {
        final Listener l = listener;
        if (l == null) {
            return;
        }
        post(new Runnable() {
            @Override
            public void run() {
                l.onPublished(topic, msg);
            }
        });
    }

    private void postServiceResponse(final String service, final JSONObject values, final boolean result) {
        final Listener l = listener;
        if (l == null) {
            return;
        }
        post(new Runnable() {
            @Override
            public void run() {
                l.onServiceResponse(service, values, result);
            }
        });
    }

    private void log(final String line) {
        Log.d(TAG, line);
        final Listener l = listener;
        if (l == null) {
            return;
        }
        post(new Runnable() {
            @Override
            public void run() {
                l.onLog(line);
            }
        });
    }

    private static String abbreviate(String s) {
        if (s == null) {
            return "";
        }
        return s.length() <= 160 ? s : s.substring(0, 160) + "\u2026";
    }
}
