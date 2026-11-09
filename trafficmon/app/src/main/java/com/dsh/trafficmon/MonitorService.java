package com.dsh.trafficmon;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;
import java.util.Locale;

/**
 * 前台服务：每 2 秒采样一次全部应用（含系统应用）的收发流量，
 * 用悬浮窗实时展示，点击折叠/展开，长按关闭。
 */
public class MonitorService extends Service {

    public static final String ACTION_START = "com.dsh.trafficmon.START";
    public static final String ACTION_STOP = "com.dsh.trafficmon.STOP";

    private static final String CHANNEL_ID = "monitor";
    private static final int NOTIF_ID = 1001;
    private static final long TICK_MS = 5000L;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private WindowManager wm;
    private WindowManager.LayoutParams params;
    private View panel;
    private TextView title;
    private LinearLayout rows;

    private TrafficTracker tracker;
    private boolean expanded = true;
    private boolean dragging = false;
    private long downAt = 0L;
    private int downX, downY, startX, startY;
    private long totalUp = 0L;
    private long totalDown = 0L;

    @Override
    public void onCreate() {
        super.onCreate();
        tracker = new TrafficTracker(this);
        startForegroundSafely();
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        if (Settings.canDrawOverlays(this)) {
            buildPanel();
        }
        handler.postDelayed(tick, 1200L);
    }

    private void startForegroundSafely() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID,
                    "流量监控", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE))
                    .createNotificationChannel(ch);
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        b.setContentTitle("流量哨兵运行中")
                .setContentText("悬浮窗实时显示各应用（含系统）上行流量")
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setOngoing(true)
                .setContentIntent(pi);

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, b.build(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, b.build());
        }
    }

    // ------------------------------------------------------------ 悬浮窗

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void buildPanel() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(10);
        root.setPadding(pad, pad, pad, pad);

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#E6101214"));
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), Color.parseColor("#33FFFFFF"));
        root.setBackground(bg);

        title = new TextView(this);
        title.setTextColor(Color.WHITE);
        title.setTextSize(13);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setText("流量哨兵 · 采样中…");
        root.addView(title);

        rows = new LinearLayout(this);
        rows.setOrientation(LinearLayout.VERTICAL);
        rows.setPadding(0, dp(6), 0, 0);
        root.addView(rows);

        panel = root;

        params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = dp(12);
        params.y = dp(160);

        root.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downAt = System.currentTimeMillis();
                        downX = (int) e.getRawX();
                        downY = (int) e.getRawY();
                        startX = params.x;
                        startY = params.y;
                        dragging = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = (int) e.getRawX() - downX;
                        int dy = (int) e.getRawY() - downY;
                        if (Math.abs(dx) > dp(4) || Math.abs(dy) > dp(4)) {
                            dragging = true;
                        }
                        if (dragging) {
                            params.x = startX + dx;
                            params.y = startY + dy;
                            try {
                                wm.updateViewLayout(panel, params);
                            } catch (Exception ignore) {
                            }
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        long held = System.currentTimeMillis() - downAt;
                        if (!dragging) {
                            if (held > 700) {
                                stopSelf();
                            } else {
                                expanded = !expanded;
                                render(lastRows, lastUp, lastDown);
                            }
                        }
                        return true;
                }
                return false;
            }
        });

        try {
            wm.addView(panel, params);
        } catch (Exception e) {
            panel = null;
        }
    }

    // ------------------------------------------------------------ 渲染

    private List<TrafficTracker.Row> lastRows;
    private long lastUp, lastDown;

    private static String human(long b) {
        if (b < 1024) {
            return b + " B";
        }
        double k = b / 1024.0;
        if (k < 1024) {
            return String.format(Locale.US, "%.0f KB", k);
        }
        return String.format(Locale.US, "%.2f MB", k / 1024.0);
    }

    private void render(List<TrafficTracker.Row> list, long up, long down) {
        if (rows == null || title == null) {
            return;
        }
        lastRows = list;
        lastUp = up;
        lastDown = down;

        title.setText(String.format(Locale.US, "↑%s/s  ↓%s/s ·5min", human(up), human(down)));
        rows.removeAllViews();
        if (!expanded) {
            return;
        }
        if (tracker != null && "none".equals(tracker.source()) && !tracker.hasUsageAccess()) {
            TextView tv = new TextView(this);
            tv.setText("读不到其它应用流量\n请授予「使用情况访问」");
            tv.setTextColor(Color.parseColor("#FFB74D"));
            tv.setTextSize(11);
            rows.addView(tv);
            return;
        }
        if (list == null || list.isEmpty()) {
            TextView tv = new TextView(this);
            String d = (tracker == null) ? "" : tracker.diag();
            tv.setText("暂无数据\n" + d);
            tv.setTextColor(Color.parseColor("#8899A6"));
            tv.setTextSize(11);
            rows.addView(tv);
            return;
        }
        int n = Math.min(list.size(), 6);
        for (int i = 0; i < n; i++) {
            TrafficTracker.Row r = list.get(i);
            TextView tv = new TextView(this);
            String tag = r.warn ? " ⚠" : (r.system ? " ·系统" : "");
            tv.setText(String.format(Locale.US, "%s  ↑%s/s%s",
                    truncate(r.label), human(r.txRate), tag));
            tv.setTextSize(11);
            tv.setTextColor(r.warn ? Color.parseColor("#FF6B6B")
                    : (r.system ? Color.parseColor("#8FA3B0") : Color.parseColor("#E0E0E0")));
            tv.setSingleLine(true);
            rows.addView(tv);
        }
    }

    private static String truncate(String s) {
        if (s == null) {
            return "?";
        }
        return s.length() <= 8 ? s : s.substring(0, 8) + "…";
    }

    // ------------------------------------------------------------ 循环

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            try {
                if (panel != null && tracker != null) {
                    List<TrafficTracker.Row> list = tracker.sample();
                    long up = 0, down = 0;
                    for (TrafficTracker.Row r : list) {
                        up += r.txRate;
                        down += r.rxRate;
                    }
                    render(list, up, down);
                }
            } catch (Exception ignore) {
            }
            handler.postDelayed(this, TICK_MS);
        }
    };

    // ------------------------------------------------------------ 生命周期

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (panel != null && wm != null) {
            try {
                wm.removeView(panel);
            } catch (Exception ignore) {
            }
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
