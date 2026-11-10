package com.dsh.trafficmon;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;


public class MainActivity extends Activity {

    private TextView status;
    private TrafficTracker tracker;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        tracker = new TrafficTracker(this);

        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int p = (int) (20 * getResources().getDisplayMetrics().density);
        root.setPadding(p, p, p, p);
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("流量哨兵  v3.1");
        title.setTextSize(24);
        root.addView(title);

        TextView desc = new TextView(this);
        desc.setTextSize(14);
        desc.setPadding(0, p / 2, 0, p / 2);
        desc.setText("每 15 秒采样一次，按最近 5 分钟窗口计算平均速率。\n"
                + "覆盖全部安装的应用，包括系统应用与共享 uid 的系统服务。\n\n"
                + "红色 = 侧载（非应用商店安装）或 72 小时内新装。\n"
                + "灰色 = 系统应用。\n\n"
                + "两个权限：\n"
                + "1. 悬浮窗 —— 显示那个小窗\n"
                + "2. 使用情况访问 —— 读其它应用（含系统）的流量");
        root.addView(desc);

        status = new TextView(this);
        status.setTextSize(13);
        status.setPadding(0, p / 2, 0, p / 2);
        root.addView(status);

        root.addView(btn("① 授予悬浮窗权限", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(MainActivity.this)) {
                    startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:" + getPackageName())));
                }
            }
        }));

        root.addView(btn("② 授予使用情况访问", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS));
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_SETTINGS));
                }
            }
        }));

        root.addView(btn("▶ 开始悬浮监控", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(MainActivity.this)) {
                    status.setText("请先授予悬浮窗权限");
                    return;
                }
                Intent i = new Intent(MainActivity.this, MonitorService.class);
                i.setAction(MonitorService.ACTION_START);
                if (Build.VERSION.SDK_INT >= 26) {
                    startForegroundService(i);
                } else {
                    startService(i);
                }
                status.setText("已启动｜悬浮窗可拖动，单击折叠，长按关闭");
            }
        }));

        root.addView(btn("🩺 自检（为什么是 0）", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                status.setText("正在自检…");
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        String crash = MyApp.lastCrash(MainActivity.this);
                        final String r = tracker.probe()
                                + (crash.isEmpty() ? "" : "\n\n上次崩溃：\n" + crash.substring(0, Math.min(600, crash.length())));
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                status.setText("自检完成");
                                new AlertDialog.Builder(MainActivity.this)
                                        .setTitle("自检结果")
                                        .setMessage(r)
                                        .setPositiveButton("好", null)
                                        .show();
                            }
                        });
                    }
                }).start();
            }
        }));

        root.addView(btn("⚡ 授权 Shizuku（可选，能读更细的数据）", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!ShizukuBridge.alive()) {
                    new AlertDialog.Builder(MainActivity.this)
                            .setTitle("Shizuku 未运行")
                            .setMessage("没有检测到 Shizuku 服务。\n\n"
                                    + "1) 安装并启动 Shizuku（或 Sui）\n"
                                    + "2) 在 Shizuku 里通过无线调试或 root 启动服务\n"
                                    + "3) 回来再点这个按钮\n\n"
                                    + "不授权也能用，只是数据粒度会粗一些。")
                            .setPositiveButton("好", null)
                            .show();
                    return;
                }
                try {
                    rikka.shizuku.Shizuku.addRequestPermissionResultListener(
                            new rikka.shizuku.Shizuku.OnRequestPermissionResultListener() {
                                @Override
                                public void onRequestPermissionResult(int requestCode, int grantResult) {
                                    if (requestCode != ShizukuBridge.REQUEST_CODE) {
                                        return;
                                    }
                                    final boolean ok = grantResult == 0;
                                    runOnUiThread(new Runnable() {
                                        @Override
                                        public void run() {
                                            ShellNetStats.invalidate();
                                            status.setText(ok ? "Shizuku 已授权" : "Shizuku 授权被拒绝");
                                        }
                                    });
                                }
                            });
                } catch (Throwable ignore) {
                }
                ShizukuBridge.request();
                status.setText("已请求 Shizuku 授权，请看弹出的对话框");
            }
        }));

        root.addView(btn("■ 停止监控", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent i = new Intent(MainActivity.this, MonitorService.class);
                i.setAction(MonitorService.ACTION_STOP);
                startService(i);
                status.setText("已停止");
            }
        }));

        setContentView(scroll);

        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
        }
    }

    private Button btn(String text, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = (int) (8 * getResources().getDisplayMetrics().density);
        b.setLayoutParams(lp);
        return b;
    }

    @Override
    protected void onResume() {
        super.onResume();
        boolean overlay = Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this);
        boolean usage = tracker.hasUsageAccess();
        status.setText("悬浮窗：" + (overlay ? "✅" : "❌")
                + "  使用情况访问：" + (usage ? "✅" : "❌"));
    }
}
