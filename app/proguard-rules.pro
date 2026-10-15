# TobotSlam3D 混淆规则
# 目前 release 未开启 minify，保留此文件供后续启用。

# okhttp / okio
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# 保留反射用到的模型类
-keep class com.tobot.slam3d.model.** { *; }
