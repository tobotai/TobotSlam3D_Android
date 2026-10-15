package com.tobot.slam3d.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;

/**
 * 手动遥控摇杆，对应 Web 控制面板「手动控制」区的圆形摇杆。
 *
 * <p>输出归一化向量：{@code x} 向右为正（正值右转），{@code y} 向上为正（正值前进），
 * 取值范围 [-1, 1]，已按摇杆半径做钳制。松手时归零并回调 {@link OnMoveListener#onRelease()}。
 */
public class JoystickView extends View {

    public interface OnMoveListener {
        /**
         * @param x 归一化横向分量，右为正
         * @param y 归一化纵向分量，上为正（前进）
         */
        void onMove(float x, float y);

        /** 松手（速度必须归零）。 */
        void onRelease();
    }

    private final Paint basePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint baseRingPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint knobPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private float centerX;
    private float centerY;
    private float baseRadius;
    private float knobRadius;

    /** 归一化后的摇杆位置。 */
    private float nx;
    private float ny;
    private boolean active;

    private OnMoveListener listener;

    public JoystickView(Context context) {
        this(context, null);
    }

    public JoystickView(Context context, AttributeSet attrs) {
        super(context, attrs);
        basePaint.setColor(0xFFEDEFF2);
        basePaint.setStyle(Paint.Style.FILL);

        baseRingPaint.setColor(0xFFD6DAE0);
        baseRingPaint.setStyle(Paint.Style.STROKE);
        baseRingPaint.setStrokeWidth(2f);

        knobPaint.setColor(0xFF2F80ED);
        knobPaint.setStyle(Paint.Style.FILL);
    }

    public void setOnMoveListener(OnMoveListener l) {
        this.listener = l;
    }

    public float getNormalizedX() {
        return nx;
    }

    public float getNormalizedY() {
        return ny;
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        centerX = w / 2f;
        centerY = h / 2f;
        baseRadius = Math.min(w, h) / 2f - 4f;
        knobRadius = baseRadius * 0.32f;
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        canvas.drawCircle(centerX, centerY, baseRadius, basePaint);
        canvas.drawCircle(centerX, centerY, baseRadius, baseRingPaint);

        float kx = centerX + nx * (baseRadius - knobRadius);
        // 屏幕 y 向下，所以取负
        float ky = centerY - ny * (baseRadius - knobRadius);
        canvas.drawCircle(kx, ky, knobRadius, knobPaint);
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_MOVE:
                active = true;
                updateFromTouch(event.getX(), event.getY());
                return true;

            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                active = false;
                nx = 0f;
                ny = 0f;
                invalidate();
                if (listener != null) {
                    listener.onRelease();
                }
                return true;

            default:
                return super.onTouchEvent(event);
        }
    }

    private void updateFromTouch(float px, float py) {
        float dx = px - centerX;
        float dy = py - centerY;
        float usable = Math.max(1f, baseRadius - knobRadius);
        float len = (float) Math.sqrt(dx * dx + dy * dy);

        float rx = dx / usable;
        float ry = -dy / usable;
        if (len > usable) {
            float k = usable / len;
            rx *= k;
            ry *= k;
        }
        // 限制在单位圆内
        float mag = (float) Math.sqrt(rx * rx + ry * ry);
        if (mag > 1f) {
            rx /= mag;
            ry /= mag;
        }
        nx = rx;
        ny = ry;
        invalidate();
        if (listener != null) {
            listener.onMove(nx, ny);
        }
    }

    /** 供外部（例如失去焦点、页面暂停）强制归零。 */
    public void reset() {
        active = false;
        nx = 0f;
        ny = 0f;
        invalidate();
    }

    public boolean isActive() {
        return active;
    }
}
