package com.tobot.slam3d;

import android.app.Application;

import com.tobot.slam3d.data.ChassisRepository;
import com.tobot.slam3d.data.Prefs;

/**
 * 应用入口：持有全局唯一的配置与底盘仓库。
 *
 * <p>仓库放在 Application 而不是 Activity 里，这样界面重建（例如切换语言、
 * 从后台回前台）不会丢掉已建立的 WebSocket 连接与已缓存的地图/路径数据。
 */
public class App extends Application {

    private static App instance;

    private Prefs prefs;
    private ChassisRepository repository;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        prefs = new Prefs(this);
        repository = new ChassisRepository();
    }

    public static App get() {
        return instance;
    }

    public Prefs prefs() {
        return prefs;
    }

    public ChassisRepository repo() {
        return repository;
    }
}
