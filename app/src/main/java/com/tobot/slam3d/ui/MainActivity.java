package com.tobot.slam3d.ui;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import com.tobot.slam3d.App;
import com.tobot.slam3d.R;
import com.tobot.slam3d.core.Pose2D;
import com.tobot.slam3d.core.TobotConstants;
import com.tobot.slam3d.data.ChassisRepository;
import com.tobot.slam3d.data.Prefs;
import com.tobot.slam3d.model.BatteryState;
import com.tobot.slam3d.model.ChassisSnapshot;
import com.tobot.slam3d.model.Goal;
import com.tobot.slam3d.model.MapInfo;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 唯一界面。按《Tbot3D导航底盘使用说明V1.0》第 3 章的五个功能分区自上而下排列：
 * 连接与状态区、路径显示画布、建图功能、导航功能、手动控制。
 *
 * <p>所有协议交互都委托给 {@link ChassisRepository}，本类只负责取值/显示与按钮状态。
 */
public class MainActivity extends AppCompatActivity implements ChassisRepository.Observer {

    private Prefs prefs;
    private ChassisRepository repo;

    private TextView statusText;
    private TextView latestInfo;
    private TextView poseText;
    private TextView batteryText;
    private TextView pathTitle;
    private TextView viewInfo;
    private TextView manualWarn;
    private EditText addressInput;
    private EditText maxLinearInput;
    private EditText maxAngularInput;
    private Button connectButton;
    private Spinner mapSpinner;
    private Spinner goalSpinner;
    private PathCanvasView pathCanvas;
    private JoystickView joystick;

    /** 下拉框里的按钮/控件引用，用于统一启用与禁用。 */
    private Button btnSelectMap;
    private Button btnDeleteMap;
    private Button btnAddGoal;
    private Button btnDeleteGoal;
    private Button btnNavigate;

    private ArrayAdapter<MapInfo> mapAdapter;
    private ArrayAdapter<Goal> goalAdapter;
    private final List<MapInfo> mapItems = new ArrayList<MapInfo>();
    private final List<Goal> goalItems = new ArrayList<Goal>();

    private ChassisSnapshot lastSnapshot;
    /** 重建下拉框时抑制回调，避免触发递归刷新。 */
    private boolean updatingSpinners;
    /**
     * 影响「下拉框 + 按钮可用性」的状态签名。
     * 位姿每秒会推很多次，只有签名变化时才重建下拉框，否则会不停 notifyDataSetChanged 造成卡顿。
     */
    private String uiSignature = "";

    private final Handler handler = new Handler(Looper.getMainLooper());

    private float joyX;
    private float joyY;
    private boolean joyActive;

    /** 手动遥控定时下发。 */
    private final Runnable manualTick = new Runnable() {
        @Override
        public void run() {
            if (!joyActive || !repo.isConnected()) {
                return;
            }
            float maxLinear = parseFloat(maxLinearInput, prefs.maxLinear());
            float maxAngular = parseFloat(maxAngularInput, prefs.maxAngular());
            // 摇杆上推 = 前进；右推 = 右转，ROS 里右转为 angular.z 负值
            repo.publishTwist(joyY * maxLinear, -joyX * maxAngular);
            handler.postDelayed(this, TobotConstants.MANUAL_PUBLISH_INTERVAL_MS);
        }
    };

    // ------------------------------------------------------------------ 生命周期

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        App app = App.get();
        prefs = app.prefs();
        repo = app.repo();

        bindViews();
        setupSpinners();
        setupListeners();

        addressInput.setText(prefs.webSocketUrl());
        maxLinearInput.setText(trimNumber(prefs.maxLinear()));
        maxAngularInput.setText(trimNumber(prefs.maxAngular()));
        manualWarn.setText(getString(R.string.warn_manual_topic, prefs.cmdVelTopic()));
        updateCanvasInfo();

        // 与 Web 控制面板一致：进入即自动连接
        connect();
    }

    @Override
    protected void onResume() {
        super.onResume();
        repo.addObserver(this);
        repo.setCmdVelTopic(prefs.cmdVelTopic());
        applySnapshot(repo.snapshot());
    }

    @Override
    protected void onPause() {
        super.onPause();
        repo.removeObserver(this);
        // 离开界面必须停车，否则摇杆的最后一次速度会一直生效
        stopManual();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        handler.removeCallbacks(manualTick);
        if (isFinishing()) {
            repo.disconnect();
        }
    }

    // ------------------------------------------------------------------ 初始化

    private void bindViews() {
        statusText = findViewById(R.id.statusText);
        latestInfo = findViewById(R.id.latestInfo);
        poseText = findViewById(R.id.poseText);
        batteryText = findViewById(R.id.batteryText);
        pathTitle = findViewById(R.id.pathTitle);
        viewInfo = findViewById(R.id.viewInfo);
        manualWarn = findViewById(R.id.manualWarn);
        addressInput = findViewById(R.id.addressInput);
        maxLinearInput = findViewById(R.id.maxLinearInput);
        maxAngularInput = findViewById(R.id.maxAngularInput);
        connectButton = findViewById(R.id.connectButton);
        mapSpinner = findViewById(R.id.mapSpinner);
        goalSpinner = findViewById(R.id.goalSpinner);
        pathCanvas = findViewById(R.id.pathCanvas);
        joystick = findViewById(R.id.joystick);

        btnSelectMap = findViewById(R.id.btnSelectMap);
        btnDeleteMap = findViewById(R.id.btnDeleteMap);
        btnAddGoal = findViewById(R.id.btnAddGoal);
        btnDeleteGoal = findViewById(R.id.btnDeleteGoal);
        btnNavigate = findViewById(R.id.btnNavigate);
    }

    private void setupSpinners() {
        mapAdapter = new ArrayAdapter<MapInfo>(this, android.R.layout.simple_spinner_item, mapItems);
        mapAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        mapSpinner.setAdapter(mapAdapter);

        goalAdapter = new ArrayAdapter<Goal>(this, android.R.layout.simple_spinner_item, goalItems);
        goalAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        goalSpinner.setAdapter(goalAdapter);
    }

    private void setupListeners() {
        connectButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (repo.isConnected()) {
                    repo.disconnect();
                } else {
                    connect();
                }
            }
        });

        // ---- 画布工具 ----
        findViewById(R.id.btnRefresh).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pathCanvas.resetView();
                updateCanvasInfo();
            }
        });
        findViewById(R.id.btnZoomIn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pathCanvas.zoomIn();
                updateCanvasInfo();
            }
        });
        findViewById(R.id.btnZoomOut).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pathCanvas.zoomOut();
                updateCanvasInfo();
            }
        });
        findViewById(R.id.btnFit).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pathCanvas.fitToContent();
                updateCanvasInfo();
            }
        });
        pathCanvas.setOnViewChangedListener(new PathCanvasView.OnViewChangedListener() {
            @Override
            public void onViewChanged(float scale, float panX, float panY) {
                updateCanvasInfo();
            }
        });

        // ---- 建图 ----
        findViewById(R.id.btnStartMapping).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!requireConnected()) {
                    return;
                }
                repo.startMapping();
            }
        });
        findViewById(R.id.btnSaveMap).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!requireConnected()) {
                    return;
                }
                askName(R.string.dlg_save_map_title, R.string.dlg_map_name_hint, "",
                        new OnNameEntered() {
                            @Override
                            public void onName(String name) {
                                repo.saveMap(name);
                            }
                        });
            }
        });

        // ---- 导航 ----
        btnSelectMap.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                MapInfo m = selectedMap();
                if (m == null) {
                    toast(R.string.toast_need_map);
                    return;
                }
                repo.selectMapAndStart(m.mapName);
            }
        });
        btnDeleteMap.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                final MapInfo m = selectedMap();
                if (m == null) {
                    toast(R.string.toast_need_map);
                    return;
                }
                confirm(getString(R.string.dlg_delete_map, m.mapName), new Runnable() {
                    @Override
                    public void run() {
                        repo.deleteMap(m.mapName);
                    }
                });
            }
        });
        btnAddGoal.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                final MapInfo m = selectedMap();
                if (m == null) {
                    toast(R.string.toast_need_map);
                    return;
                }
                if (lastSnapshot == null || lastSnapshot.pose == null) {
                    toast(R.string.toast_no_pose);
                    return;
                }
                // 「添加目标点」按底盘当前位姿保存（与 Web 面板一致）
                askName(R.string.dlg_add_goal_title, R.string.dlg_goal_name_hint,
                        getString(R.string.dlg_goal_position), new OnNameEntered() {
                            @Override
                            public void onName(String name) {
                                Pose2D p = lastSnapshot.pose;
                                repo.addGoal(m.mapName, name, p.x, p.y, p.yaw);
                            }
                        });
            }
        });
        btnDeleteGoal.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                final MapInfo m = selectedMap();
                final Goal g = selectedGoal();
                if (m == null) {
                    toast(R.string.toast_need_map);
                    return;
                }
                if (g == null) {
                    toast(R.string.toast_need_goal);
                    return;
                }
                confirm(getString(R.string.dlg_delete_goal, g.name), new Runnable() {
                    @Override
                    public void run() {
                        repo.deleteGoal(m.mapName, g.name);
                    }
                });
            }
        });
        btnNavigate.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Goal g = selectedGoal();
                if (g == null) {
                    toast(R.string.toast_need_goal);
                    return;
                }
                repo.navigateTo(g.x, g.y);
            }
        });
        findViewById(R.id.btnCancelNav).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                repo.cancelNavigation();
            }
        });
        findViewById(R.id.btnDock).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!requireConnected()) {
                    return;
                }
                repo.docking();
            }
        });

        mapSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (updatingSpinners) {
                    return;
                }
                rebuildGoals();
                updateButtonStates();
                refreshCanvas();
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });

        goalSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (updatingSpinners) {
                    return;
                }
                updateButtonStates();
                refreshCanvas();
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });

        // ---- 手动控制 ----
        joystick.setOnMoveListener(new JoystickView.OnMoveListener() {
            @Override
            public void onMove(float x, float y) {
                joyX = x;
                joyY = y;
                if (!joyActive) {
                    joyActive = true;
                    handler.removeCallbacks(manualTick);
                    handler.post(manualTick);
                }
            }

            @Override
            public void onRelease() {
                stopManual();
            }
        });

        // 长按「手动控制」标题可修改话题名（官方 SDK 未公开速度接口，现场可能需改）
        findViewById(R.id.manualTitle).setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                askName(R.string.dlg_topic_title, R.string.dlg_topic_hint, prefs.cmdVelTopic(),
                        new OnNameEntered() {
                            @Override
                            public void onName(String name) {
                                prefs.setCmdVelTopic(name);
                                repo.setCmdVelTopic(prefs.cmdVelTopic());
                                manualWarn.setText(getString(R.string.warn_manual_topic, prefs.cmdVelTopic()));
                            }
                        });
                return true;
            }
        });
    }

    // ------------------------------------------------------------------ 连接

    private void connect() {
        String url = prefs.applyUrl(addressInput.getText().toString());
        if (url == null) {
            toast(R.string.toast_invalid_address);
            addressInput.setText(prefs.webSocketUrl());
            url = prefs.webSocketUrl();
        }
        addressInput.setText(url);
        statusText.setText(R.string.status_connecting);
        statusText.setTextColor(ContextCompat.getColor(this, R.color.text_secondary));
        repo.connect(url);
    }

    // ------------------------------------------------------------------ 状态更新

    @Override
    public void onSnapshot(ChassisSnapshot snapshot) {
        applySnapshot(snapshot);
    }

    @Override
    public void onLog(String line) {
        // 日志已由仓库合并进 lastMessage，这里只在界面上保留最近一条
    }

    private void applySnapshot(ChassisSnapshot s) {
        if (s == null) {
            return;
        }
        lastSnapshot = s;

        statusText.setText(s.connected ? R.string.status_connected : R.string.status_disconnected);
        statusText.setTextColor(ContextCompat.getColor(this,
                s.connected ? R.color.status_ok : R.color.status_bad));
        connectButton.setText(s.connected ? R.string.btn_disconnect : R.string.btn_connect);
        connectButton.setBackgroundTintList(android.content.res.ColorStateList.valueOf(
                ContextCompat.getColor(this, s.connected ? R.color.btn_red : R.color.btn_teal)));

        latestInfo.setText(s.lastMessage);

        poseText.setText(getString(R.string.label_pose) + ": "
                + (s.pose == null ? "--" : s.pose.toString()));

        BatteryState b = s.battery;
        batteryText.setText(getString(R.string.label_battery) + ": "
                + (b.valid ? b.describe() : "--"));

        pathTitle.setText(getString(R.string.path_points_format, s.path.size()));

        // 下拉框与按钮只在「地图列表 / 选中项 / 连接状态」变化时重建
        String sig = s.connected + "|" + mapsSignature(s.maps)
                + "|" + selectedName(mapSpinner.getSelectedItemPosition(), mapItems)
                + "|" + selectedName(goalSpinner.getSelectedItemPosition(), goalItems);
        if (!sig.equals(uiSignature)) {
            uiSignature = sig;
            rebuildMaps(s.maps);
            updateButtonStates();
        }
        refreshCanvas();
    }

    /** 地图列表的稳定签名：名称 + 目标点数量 + 目标点名称与坐标。 */
    private static String mapsSignature(List<MapInfo> maps) {
        if (maps == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (MapInfo m : maps) {
            sb.append(m.mapName).append('(').append(m.goals().size()).append(')');
            for (Goal g : m.goals()) {
                sb.append(g.name).append(',')
                        .append(Math.round(g.x * 1000)).append(',')
                        .append(Math.round(g.y * 1000)).append(';');
            }
            sb.append('|');
        }
        return sb.toString();
    }

    /** 取下拉框当前项的名字（第 0 项是占位符），用于生成签名。 */
    private static String selectedName(int position, List<?> items) {
        if (position <= 0 || position >= items.size()) {
            return "-";
        }
        return String.valueOf(items.get(position));
    }

    /** 按名称保留当前选中的地图，避免每次刷新地图列表都把选择清掉。 */
    private void rebuildMaps(List<MapInfo> maps) {
        String keepName = null;
        MapInfo current = selectedMap();
        if (current != null) {
            keepName = current.mapName;
        }

        updatingSpinners = true;
        mapItems.clear();
        // 第 0 项是占位符，表示「未选择地图」
        mapItems.add(new MapInfo(getString(R.string.hint_select_map), "", null));
        if (maps != null) {
            mapItems.addAll(maps);
        }
        mapAdapter.notifyDataSetChanged();

        int target = 0;
        if (keepName != null) {
            for (int i = 1; i < mapItems.size(); i++) {
                if (keepName.equals(mapItems.get(i).mapName)) {
                    target = i;
                    break;
                }
            }
        }
        mapSpinner.setSelection(target, false);
        updatingSpinners = false;

        rebuildGoals();
    }

    private void rebuildGoals() {
        String keepName = null;
        Goal current = selectedGoal();
        if (current != null) {
            keepName = current.name;
        }

        updatingSpinners = true;
        goalItems.clear();
        goalItems.add(new Goal(getString(R.string.hint_select_goal), 0d, 0d, 0d));
        MapInfo m = selectedMap();
        if (m != null) {
            goalItems.addAll(m.goals());
        }
        goalAdapter.notifyDataSetChanged();

        int target = 0;
        if (keepName != null) {
            for (int i = 1; i < goalItems.size(); i++) {
                if (keepName.equals(goalItems.get(i).name)) {
                    target = i;
                    break;
                }
            }
        }
        goalSpinner.setSelection(target, false);
        updatingSpinners = false;
    }

    /** 与 Web 面板一致：未选地图时地图管理按钮禁用。 */
    private void updateButtonStates() {
        boolean hasMap = selectedMap() != null;
        boolean hasGoal = selectedGoal() != null;
        boolean connected = repo.isConnected();

        btnDeleteMap.setEnabled(hasMap);
        btnAddGoal.setEnabled(hasMap);
        btnDeleteGoal.setEnabled(hasMap && hasGoal);
        btnSelectMap.setEnabled(hasMap);
        btnNavigate.setEnabled(hasGoal);
        findViewById(R.id.btnCancelNav).setEnabled(connected);
        findViewById(R.id.btnDock).setEnabled(connected);
        findViewById(R.id.btnStartMapping).setEnabled(connected);
        findViewById(R.id.btnSaveMap).setEnabled(connected);

        applyEnabledTint(btnDeleteMap, R.color.btn_pink);
        applyEnabledTint(btnAddGoal, R.color.btn_green_light);
        applyEnabledTint(btnDeleteGoal, R.color.btn_pink_light);
        applyEnabledTint(btnSelectMap, R.color.btn_teal);
        applyEnabledTint(btnNavigate, R.color.btn_amber);
        applyEnabledTint(findViewById(R.id.btnCancelNav), R.color.btn_teal);
        applyEnabledTint(findViewById(R.id.btnDock), R.color.btn_green);
        applyEnabledTint(findViewById(R.id.btnStartMapping), R.color.btn_blue);
        applyEnabledTint(findViewById(R.id.btnSaveMap), R.color.btn_green);
    }

    private void applyEnabledTint(Button b, int colorRes) {
        int color = ContextCompat.getColor(this, b.isEnabled() ? colorRes : R.color.btn_disabled);
        b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(color));
    }

    private void refreshCanvas() {
        if (pathCanvas == null) {
            return;
        }
        Pose2D pose = lastSnapshot == null ? null : lastSnapshot.pose;
        List<Pose2D> path = lastSnapshot == null ? null : lastSnapshot.path;
        MapInfo m = selectedMap();
        List<Goal> goals = m == null ? null : m.goals();
        pathCanvas.setData(pose, path, goals);
        updateCanvasInfo();
    }

    private void updateCanvasInfo() {
        if (viewInfo != null && pathCanvas != null) {
            viewInfo.setText(pathCanvas.describeView());
        }
    }

    // ------------------------------------------------------------------ 手动控制

    private void stopManual() {
        joyActive = false;
        joyX = 0f;
        joyY = 0f;
        handler.removeCallbacks(manualTick);
        if (joystick != null) {
            joystick.reset();
        }
        repo.stopMotion();
    }

    // ------------------------------------------------------------------ 小工具

    private MapInfo selectedMap() {
        int pos = mapSpinner.getSelectedItemPosition();
        if (pos <= 0 || pos >= mapItems.size()) {
            return null;
        }
        return mapItems.get(pos);
    }

    private Goal selectedGoal() {
        int pos = goalSpinner.getSelectedItemPosition();
        if (pos <= 0 || pos >= goalItems.size()) {
            return null;
        }
        return goalItems.get(pos);
    }

    private boolean requireConnected() {
        if (!repo.isConnected()) {
            toast(R.string.toast_need_connect);
            return false;
        }
        return true;
    }

    private void toast(int resId) {
        Toast.makeText(this, resId, Toast.LENGTH_SHORT).show();
    }

    private void confirm(String message, final Runnable onYes) {
        new AlertDialog.Builder(this)
                .setMessage(message)
                .setNegativeButton(R.string.btn_cancel, null)
                .setPositiveButton(R.string.btn_confirm, new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface dialog, int which) {
                        onYes.run();
                    }
                })
                .show();
    }

    /** 名称输入回调。 */
    private interface OnNameEntered {
        void onName(String name);
    }

    /**
     * 弹出单行输入框。
     *
     * @param note 输入框下方的说明文字；传空串表示不显示
     */
    private void askName(int titleRes, int hintRes, String initial, final OnNameEntered callback) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        input.setHint(hintRes);
        input.setText(initial == null ? "" : initial);
        input.setSelection(input.getText().length());

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad / 2, pad, 0);
        box.addView(input, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        if (initial != null && !initial.isEmpty() && initial.length() > 1 && !initial.startsWith("/")) {
            TextView note = new TextView(this);
            note.setText(initial);
            note.setTextSize(12f);
            note.setTextColor(ContextCompat.getColor(this, R.color.text_hint));
            note.setPadding(0, pad / 3, 0, 0);
            box.addView(note);
        }

        new AlertDialog.Builder(this)
                .setTitle(titleRes)
                .setView(box)
                .setNegativeButton(R.string.btn_cancel, null)
                .setPositiveButton(R.string.btn_confirm, new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface dialog, int which) {
                        String name = input.getText().toString().trim();
                        if (name.isEmpty()) {
                            toast(R.string.toast_need_name);
                            return;
                        }
                        callback.onName(name);
                    }
                })
                .show();
    }

    private static float parseFloat(EditText et, float def) {
        if (et == null) {
            return def;
        }
        String s = et.getText().toString().trim();
        if (s.isEmpty()) {
            return def;
        }
        try {
            float v = Float.parseFloat(s);
            return v > 0f ? v : def;
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static String trimNumber(float v) {
        if (v == Math.rint(v)) {
            return String.format(Locale.US, "%.1f", v);
        }
        return String.format(Locale.US, "%s", Float.toString(v));
    }
}
