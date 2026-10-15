package com.tobot.slam3d.model;

import com.tobot.slam3d.core.TobotConstants;

import java.util.Locale;

/**
 * 电量与充电状态（来自 /ebot_work_state）。
 *
 * <p><b>注意协议里「未充电」是 2，不是 0。</b>任何非 1 的值都按未充电处理，
 * 但界面文案只在确实拿到数据后才显示，避免把「未知」显示成「未充电」。
 */
public final class BatteryState {

    /** 尚未收到任何 /ebot_work_state 数据。 */
    public static final BatteryState UNKNOWN = new BatteryState(false, -1d, false);

    public final boolean charging;
    /** 电量百分比 0~100；未知时为负值。 */
    public final double percent;
    /** 是否已收到过有效数据。 */
    public final boolean valid;

    public BatteryState(boolean charging, double percent, boolean valid) {
        this.charging = charging;
        this.percent = percent;
        this.valid = valid;
    }

    /**
     * 由 /ebot_work_state 的 data 数组构造。
     *
     * @param chargeState data[0]：1=充电中，其它（含 2）=未充电
     * @param percent     data[1]：电量百分比
     */
    public static BatteryState fromData(double chargeState, double percent) {
        boolean charging = ((int) chargeState) == TobotConstants.WORK_STATE_CHARGING;
        return new BatteryState(charging, percent, true);
    }

    /** 形如 {@code 75.5% · 充电中}；无数据时返回空串。 */
    public String describe() {
        if (!valid) {
            return "";
        }
        String p = String.format(Locale.US, "%.0f%%", percent);
        return charging ? p + " \u00b7 \u5145\u7535\u4e2d" : p + " \u00b7 \u672a\u5145\u7535";
    }
}
