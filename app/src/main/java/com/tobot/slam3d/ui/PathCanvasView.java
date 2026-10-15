package com.tobot.slam3d.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;

import com.tobot.slam3d.core.Pose2D;
import com.tobot.slam3d.model.Goal;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 路径显示画布。
 *
 * <p>对应 Web 控制面板的「路径显示」区：只画 **实时定位（位姿）** 与 **规划路径**，
 * 外加已保存的目标点，标题栏统计路径点数，左下角显示缩放比例与平移量。
 *
 * <p>⚠️ 为什么没有栅格地图：3D 版 SDK 只暴露 5 个 Topic，
 * 其中**不包含**占据栅格地图、地图图片或 3D 点云，因此无法（也不应该假装能）画出 SLAM 栅格图。
 * 这一点与旧版 Slamtec 私有协议完全不同（旧版地图由闭源 MapView 渲染）。
 *
 * <p>坐标约定：底盘世界坐标 x 向右、y 向上，单位米；屏幕坐标 y 向下，绘制时翻转。
 */
public class PathCanvasView extends View {

    /** 视图状态变化（缩放/平移），用于刷新左下角文字。 */
    public interface OnViewChangedListener {
        void onViewChanged(float scale, float panX, float panY);
    }

    private static final float MIN_SCALE = 4f;
    private static final float MAX_SCALE = 400f;
    private static final float GRID_MIN_PX = 24f;

    private final Paint gridPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint gridPaintMajor = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint axisPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint pathPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint pathPointPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint robotPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint robotStrokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint goalPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint goalTextPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint hintPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private final Path robotPath = new Path();

    /** 每米对应多少像素。 */
    private float scale = 40f;
    /** 世界原点在屏幕上的位置。 */
    private float originX;
    private float originY;
    private boolean originInitialised;

    private Pose2D pose;
    private List<Pose2D> path = new ArrayList<Pose2D>();
    private List<Goal> goals = new ArrayList<Goal>();

    private OnViewChangedListener viewChangedListener;

    // 手势
    private float lastTouchX;
    private float lastTouchY;
    private boolean dragging;
    private float lastSpan = -1f;

    public PathCanvasView(Context context) {
        this(context, null);
    }

    public PathCanvasView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    private void init() {
        gridPaint.setColor(0xFFE8ECF1);
        gridPaint.setStyle(Paint.Style.STROKE);
        gridPaint.setStrokeWidth(1f);

        gridPaintMajor.setColor(0xFFD3DAE3);
        gridPaintMajor.setStyle(Paint.Style.STROKE);
        gridPaintMajor.setStrokeWidth(1f);

        axisPaint.setColor(0xFFB9C2CC);
        axisPaint.setStyle(Paint.Style.STROKE);
        axisPaint.setStrokeWidth(2f);

        pathPaint.setColor(0xFF1565C0);
        pathPaint.setStyle(Paint.Style.STROKE);
        pathPaint.setStrokeWidth(3f);
        pathPaint.setStrokeCap(Paint.Cap.ROUND);
        pathPaint.setStrokeJoin(Paint.Join.ROUND);

        pathPointPaint.setColor(0xFF1565C0);
        pathPointPaint.setStyle(Paint.Style.FILL);

        robotPaint.setColor(0xFF2E7D32);
        robotPaint.setStyle(Paint.Style.FILL);

        robotStrokePaint.setColor(0xFF1B5E20);
        robotStrokePaint.setStyle(Paint.Style.STROKE);
        robotStrokePaint.setStrokeWidth(2f);

        goalPaint.setColor(0xFFE53935);
        goalPaint.setStyle(Paint.Style.FILL);

        goalTextPaint.setColor(0xFF37474F);
        goalTextPaint.setTextSize(sp(11f));

        hintPaint.setColor(0xFF9AA5B1);
        hintPaint.setTextSize(sp(12f));
        hintPaint.setAntiAlias(true);
    }

    private float sp(float v) {
        return v * getResources().getDisplayMetrics().scaledDensity;
    }

    public void setOnViewChangedListener(OnViewChangedListener l) {
        this.viewChangedListener = l;
    }

    /** 更新要绘制的数据并重绘。 */
    public void setData(Pose2D pose, List<Pose2D> path, List<Goal> goals) {
        this.pose = pose;
        this.path = path == null ? new ArrayList<Pose2D>() : path;
        this.goals = goals == null ? new ArrayList<Goal>() : goals;
        if (!originInitialised && getWidth() > 0) {
            resetView();
        }
        invalidate();
    }

    public int pathPointCount() {
        return path.size();
    }

    // ------------------------------------------------------------------ 视图操作

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        if (!originInitialised) {
            resetView();
        }
    }

    /** 刷新视图：缩放与平移复位。 */
    public void resetView() {
        scale = 40f;
        originX = getWidth() / 2f;
        originY = getHeight() / 2f;
        originInitialised = true;
        notifyViewChanged();
        invalidate();
    }

    public void zoomIn() {
        zoomBy(1.4f);
    }

    public void zoomOut() {
        zoomBy(1f / 1.4f);
    }

    /** 以画布中心为锚点缩放。 */
    public void zoomBy(float factor) {
        float cx = getWidth() / 2f;
        float cy = getHeight() / 2f;
        float newScale = clamp(scale * factor);
        float k = newScale / scale;
        originX = cx - (cx - originX) * k;
        originY = cy - (cy - originY) * k;
        scale = newScale;
        notifyViewChanged();
        invalidate();
    }

    /** 全屏适配：把当前路径、位姿与目标点全部纳入视野。 */
    public void fitToContent() {
        float minX = Float.MAX_VALUE;
        float minY = Float.MAX_VALUE;
        float maxX = -Float.MAX_VALUE;
        float maxY = -Float.MAX_VALUE;
        boolean any = false;
        for (Pose2D p : path) {
            minX = Math.min(minX, (float) p.x);
            minY = Math.min(minY, (float) p.y);
            maxX = Math.max(maxX, (float) p.x);
            maxY = Math.max(maxY, (float) p.y);
            any = true;
        }
        for (Goal g : goals) {
            minX = Math.min(minX, (float) g.x);
            minY = Math.min(minY, (float) g.y);
            maxX = Math.max(maxX, (float) g.x);
            maxY = Math.max(maxY, (float) g.y);
            any = true;
        }
        if (pose != null) {
            minX = Math.min(minX, (float) pose.x);
            minY = Math.min(minY, (float) pose.y);
            maxX = Math.max(maxX, (float) pose.x);
            maxY = Math.max(maxY, (float) pose.y);
            any = true;
        }
        int w = getWidth();
        int h = getHeight();
        if (!any || w <= 0 || h <= 0) {
            resetView();
            return;
        }
        float spanX = Math.max(maxX - minX, 1f);
        float spanY = Math.max(maxY - minY, 1f);
        float margin = 0.15f;
        float scaleX = w * (1f - margin) / spanX;
        float scaleY = h * (1f - margin) / spanY;
        scale = clamp(Math.min(scaleX, scaleY));
        float centerX = (minX + maxX) / 2f;
        float centerY = (minY + maxY) / 2f;
        originX = w / 2f - centerX * scale;
        // 屏幕 y 向下，世界 y 向上：原点 y 要加上中心 y 的偏移
        originY = h / 2f + centerY * scale;
        originInitialised = true;
        notifyViewChanged();
        invalidate();
    }

    private float clamp(float s) {
        return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    }

    // ------------------------------------------------------------------ 坐标换算

    private float toScreenX(double worldX) {
        return originX + (float) worldX * scale;
    }

    private float toScreenY(double worldY) {
        return originY - (float) worldY * scale;
    }

    // ------------------------------------------------------------------ 绘制

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (!originInitialised) {
            originInitialised = true;
            originX = getWidth() / 2f;
            originY = getHeight() / 2f;
        }
        drawGrid(canvas);
        drawPath(canvas);
        drawGoals(canvas);
        drawRobot(canvas);
        drawHint(canvas);
    }

    private void drawGrid(Canvas canvas) {
        int w = getWidth();
        int h = getHeight();

        // 网格步长自适应：保证格子在屏幕上不小于 GRID_MIN_PX
        float stepMeters = 1f;
        while (stepMeters * scale < GRID_MIN_PX) {
            stepMeters *= (stepMeters == 1f) ? 5f : 2f;
        }

        float leftWorld = (0f - originX) / scale;
        float rightWorld = (w - originX) / scale;
        float topWorld = (originY - 0f) / scale;
        float bottomWorld = (originY - h) / scale;

        float startX = (float) Math.floor(leftWorld / stepMeters) * stepMeters;
        for (float x = startX; x <= rightWorld; x += stepMeters) {
            float sx = toScreenX(x);
            boolean major = Math.abs(x / (stepMeters * 5f) - Math.rint(x / (stepMeters * 5f))) < 1e-4;
            canvas.drawLine(sx, 0, sx, h, major ? gridPaintMajor : gridPaint);
        }
        float startY = (float) Math.floor(bottomWorld / stepMeters) * stepMeters;
        for (float y = startY; y <= topWorld; y += stepMeters) {
            float sy = toScreenY(y);
            boolean major = Math.abs(y / (stepMeters * 5f) - Math.rint(y / (stepMeters * 5f))) < 1e-4;
            canvas.drawLine(0, sy, w, sy, major ? gridPaintMajor : gridPaint);
        }

        // 世界坐标轴
        float ax = toScreenX(0);
        float ay = toScreenY(0);
        if (ax >= 0 && ax <= w) {
            canvas.drawLine(ax, 0, ax, h, axisPaint);
        }
        if (ay >= 0 && ay <= h) {
            canvas.drawLine(0, ay, w, ay, axisPaint);
        }
    }

    private void drawPath(Canvas canvas) {
        if (path.size() < 2) {
            if (path.size() == 1) {
                Pose2D p = path.get(0);
                canvas.drawCircle(toScreenX(p.x), toScreenY(p.y), 3f, pathPointPaint);
            }
            return;
        }
        robotPath.reset();
        Pose2D first = path.get(0);
        robotPath.moveTo(toScreenX(first.x), toScreenY(first.y));
        for (int i = 1; i < path.size(); i++) {
            Pose2D p = path.get(i);
            robotPath.lineTo(toScreenX(p.x), toScreenY(p.y));
        }
        canvas.drawPath(robotPath, pathPaint);

        // 路径点（点较多时只画首末，避免糊成一团）
        if (path.size() <= 64) {
            for (Pose2D p : path) {
                canvas.drawCircle(toScreenX(p.x), toScreenY(p.y), 2.5f, pathPointPaint);
            }
        }
    }

    private void drawGoals(Canvas canvas) {
        for (Goal g : goals) {
            float sx = toScreenX(g.x);
            float sy = toScreenY(g.y);
            canvas.drawCircle(sx, sy, 6f, goalPaint);
            canvas.drawCircle(sx, sy, 9f, robotStrokePaint);
            if (g.name != null && !g.name.isEmpty()) {
                canvas.drawText(g.name, sx + 12f, sy - 8f, goalTextPaint);
            }
        }
    }

    private void drawRobot(Canvas canvas) {
        if (pose == null) {
            return;
        }
        float sx = toScreenX(pose.x);
        float sy = toScreenY(pose.y);

        // 机身：一个沿 yaw 指向的三角形
        float r = 14f;
        double a = pose.yaw;
        float fx = (float) Math.cos(a);
        float fy = (float) Math.sin(a);
        // 屏幕 y 反向
        float tipX = sx + fx * r;
        float tipY = sy - fy * r;
        float leftX = sx + (float) Math.cos(a + 2.5d) * r * 0.75f;
        float leftY = sy - (float) Math.sin(a + 2.5d) * r * 0.75f;
        float rightX = sx + (float) Math.cos(a - 2.5d) * r * 0.75f;
        float rightY = sy - (float) Math.sin(a - 2.5d) * r * 0.75f;

        Path tri = new Path();
        tri.moveTo(tipX, tipY);
        tri.lineTo(leftX, leftY);
        tri.lineTo(rightX, rightY);
        tri.close();
        canvas.drawPath(tri, robotPaint);
        canvas.drawPath(tri, robotStrokePaint);
    }

    private void drawHint(Canvas canvas) {
        if (pose == null && path.isEmpty() && goals.isEmpty()) {
            canvas.drawText("\u7b49\u5f85\u5e95\u76d8\u6570\u636e\u2026",
                    16f, getHeight() - 16f, hintPaint);
        }
    }

    private void notifyViewChanged() {
        if (viewChangedListener != null) {
            // 平移量以米为单位显示，与 Web 面板的「平移: (0, 0)」一致
            float panX = (getWidth() / 2f - originX) / scale;
            float panY = (originY - getHeight() / 2f) / scale;
            viewChangedListener.onViewChanged(scale, panX, panY);
        }
    }

    // ------------------------------------------------------------------ 手势

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                lastTouchX = event.getX();
                lastTouchY = event.getY();
                dragging = true;
                lastSpan = -1f;
                return true;

            case MotionEvent.ACTION_POINTER_DOWN:
                if (event.getPointerCount() >= 2) {
                    lastSpan = span(event);
                    dragging = false;
                }
                return true;

            case MotionEvent.ACTION_MOVE:
                if (event.getPointerCount() >= 2) {
                    float s = span(event);
                    if (lastSpan > 0f && s > 0f) {
                        float factor = s / lastSpan;
                        float cx = (event.getX(0) + event.getX(1)) / 2f;
                        float cy = (event.getY(0) + event.getY(1)) / 2f;
                        float newScale = clamp(scale * factor);
                        float k = newScale / scale;
                        originX = cx - (cx - originX) * k;
                        originY = cy - (cy - originY) * k;
                        scale = newScale;
                        notifyViewChanged();
                        invalidate();
                    }
                    lastSpan = s;
                } else if (dragging) {
                    float dx = event.getX() - lastTouchX;
                    float dy = event.getY() - lastTouchY;
                    originX += dx;
                    originY += dy;
                    lastTouchX = event.getX();
                    lastTouchY = event.getY();
                    notifyViewChanged();
                    invalidate();
                }
                return true;

            case MotionEvent.ACTION_POINTER_UP:
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                dragging = false;
                lastSpan = -1f;
                return true;

            default:
                return super.onTouchEvent(event);
        }
    }

    private static float span(MotionEvent e) {
        if (e.getPointerCount() < 2) {
            return -1f;
        }
        float dx = e.getX(0) - e.getX(1);
        float dy = e.getY(0) - e.getY(1);
        return (float) Math.sqrt(dx * dx + dy * dy);
    }

    /** 供界面显示的缩放/平移文本。 */
    public String describeView() {
        float panX = (getWidth() / 2f - originX) / scale;
        float panY = (originY - getHeight() / 2f) / scale;
        return String.format(Locale.US, "\u7f29\u653e: %.2fx | \u5e73\u79fb: (%.2f, %.2f)",
                scale / 40f, panX, panY);
    }
}
