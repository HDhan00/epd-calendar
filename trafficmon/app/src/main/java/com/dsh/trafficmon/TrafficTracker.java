package com.dsh.trafficmon;

import android.app.AppOpsManager;
import android.app.usage.NetworkStats;
import android.app.usage.NetworkStatsManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.TrafficStats;
import android.os.Build;
import android.os.Process;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 采集层（v1.2）：双通道 + 自动切换 + 自检。
 *
 * 背景：Android 10 起，非系统应用调用 TrafficStats.getUid*Bytes(其它 uid)
 * 往往返回 UNSUPPORTED，甚至返回 0。所以必须有 NetworkStatsManager 兜底，
 * 而它依赖「使用情况访问」权限。
 */
public class TrafficTracker {

    public static class Row {
        public int uid;
        public String pkg;
        public String label;
        public long txRate;
        public long rxRate;
        public long txTotal;
        public boolean system;
        public boolean warn;
    }

    private static class Meta {
        String pkg = "?";
        String label = "?";
        boolean system, sideload, fresh;
    }

    private final Context ctx;
    private final PackageManager pm;
    private final NetworkStatsManager nsm;

    private final Map<Integer, Meta> meta = new HashMap<>();
    private final Map<Integer, long[]> prev = new HashMap<>();
    private final Map<Integer, Long> total = new HashMap<>();
    private List<Integer> uidList = new ArrayList<>();

    private long lastRefreshMs = 0L;
    private long lastSampleMs = 0L;

    // 诊断状态
    private String source = "init";        // sh / ns / ts / none
    private int tsOk = 0, tsFail = 0;
    private int zeroTicks = 0;
    private String nsError = "";

    public TrafficTracker(Context c) {
        ctx = c.getApplicationContext();
        pm = ctx.getPackageManager();
        nsm = (NetworkStatsManager) ctx.getSystemService(Context.NETWORK_STATS_SERVICE);
    }

    public String source() {
        return source;
    }

    public String diag() {
        return "src=" + source + " ts=" + tsOk + "/" + (tsOk + tsFail)
                + " zero=" + zeroTicks + (nsError.isEmpty() ? "" : " ns:" + nsError);
    }

    public boolean hasUsageAccess() {
        try {
            AppOpsManager aom = (AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
            int mode = aom.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(), ctx.getPackageName());
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    // ---------------------------------------------------------------- 应用清单

    private void refreshApps() {
        long now = System.currentTimeMillis();
        if (now - lastRefreshMs < 30_000L && !uidList.isEmpty()) {
            return;
        }
        lastRefreshMs = now;
        Set<Integer> uids = new HashSet<>();
        try {
            for (ApplicationInfo ai : pm.getInstalledApplications(PackageManager.GET_META_DATA)) {
                uids.add(ai.uid);
            }
        } catch (Exception ignore) {
        }
        uidList = new ArrayList<>(uids);
    }

    private Meta metaOf(int uid) {
        Meta m = meta.get(uid);
        if (m != null) {
            return m;
        }
        m = new Meta();
        try {
            String[] pkgs = pm.getPackagesForUid(uid);
            if (pkgs != null && pkgs.length > 0) {
                m.pkg = pkgs[0];
                ApplicationInfo ai = pm.getApplicationInfo(m.pkg, 0);
                m.label = String.valueOf(pm.getApplicationLabel(ai));
                m.system = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0
                        || (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0;
                String installer;
                if (Build.VERSION.SDK_INT >= 30) {
                    installer = pm.getInstallSourceInfo(m.pkg).getInstallingPackageName();
                } else {
                    installer = pm.getInstallerPackageName(m.pkg);
                }
                m.sideload = (installer == null || installer.isEmpty());
                m.fresh = (System.currentTimeMillis() - pm.getPackageInfo(m.pkg, 0).firstInstallTime)
                        < 72L * 3600_000L;
            } else {
                m.label = "共享 uid " + uid;
            }
        } catch (Exception ignore) {
        }
        meta.put(uid, m);
        return m;
    }

    // ---------------------------------------------------------------- 采样

    // ---- 滑动窗口：每条记录 {ts, tx, rx}
    private static final int HIST = 20;          // 20 × 15s = 5 分钟
    private static final long NS_INTERVAL = 15000L;
    private final Map<Integer, java.util.ArrayDeque<long[]>> hist = new HashMap<>();
    private long lastNsMs = 0L;
    private List<Row> lastRows = new ArrayList<>();

    public List<Row> sample() {
        long now = System.currentTimeMillis();
        if (now - lastNsMs < NS_INTERVAL && !lastRows.isEmpty()) {
            return lastRows;                     // 未到刷新点，沿用上次结果
        }
        refreshApps();

        // ⓪ Shizuku(shell) 通道：能拿到 service 内部累计计数，粒度最细
        Map<Integer, long[]> cur = null;
        if (cur == null && ShizukuBridge.ready()) {
            Map<Integer, long[]> sh = ShellNetStats.read();
            if (sh != null && !sh.isEmpty()) {
                cur = sh;
                source = "sh";
            }
        }

        // ① NetworkStatsManager
        if (cur == null) {
            cur = readNetworkStats(6L * 3600_000L);
        }
        if (cur == null || cur.isEmpty()) {
            Map<Integer, long[]> ts = new HashMap<>();
            if (readTrafficStats(ts) && !ts.isEmpty()) {
                cur = ts;
                source = "ts";
            } else {
                source = "none";
                return lastRows;
            }
        } else {
            source = "ns";
        }
        lastNsMs = now;

        List<Row> out = new ArrayList<>();
        for (Map.Entry<Integer, long[]> e : cur.entrySet()) {
            int uid = e.getKey();
            long tx = e.getValue()[0];
            long rx = e.getValue()[1];

            java.util.ArrayDeque<long[]> q = hist.get(uid);
            if (q == null) {
                q = new java.util.ArrayDeque<>();
                hist.put(uid, q);
            }
            // 桶轮转或计数回退：清空历史重新计
            long[] last = q.peekLast();
            if (last != null && (tx < last[1] || rx < last[2])) {
                q.clear();
            }
            q.addLast(new long[]{now, tx, rx});
            while (q.size() > HIST) {
                q.removeFirst();
            }
            long[] first = q.peekFirst();
            long span = now - first[0];
            if (span < 3000) {
                continue;                        // 至少 3 秒才有意义
            }
            long dTx = Math.max(0, tx - first[1]);
            long dRx = Math.max(0, rx - first[2]);
            if (dTx == 0 && dRx == 0) {
                continue;
            }
            Meta m = metaOf(uid);
            Row r = new Row();
            r.uid = uid;
            r.pkg = m.pkg;
            r.label = m.label;
            r.txRate = (long) (dTx * 1000L / span);   // 窗口内平均 B/s
            r.rxRate = (long) (dRx * 1000L / span);
            r.txTotal = dTx;                          // 窗口内累计
            r.system = m.system;
            r.warn = m.sideload || m.fresh;
            out.add(r);
        }

        Collections.sort(out, new Comparator<Row>() {
            @Override
            public int compare(Row a, Row b) {
                return Long.compare(b.txRate, a.txRate);
            }
        });
        lastRows = out;
        zeroTicks = out.isEmpty() ? zeroTicks + 1 : 0;
        return out;
    }

    private boolean readTrafficStats(Map<Integer, long[]> out) {
        tsOk = 0;
        tsFail = 0;
        for (Integer uid : uidList) {
            long tx, rx;
            try {
                tx = TrafficStats.getUidTxBytes(uid);
                rx = TrafficStats.getUidRxBytes(uid);
            } catch (Exception e) {
                tx = TrafficStats.UNSUPPORTED;
                rx = TrafficStats.UNSUPPORTED;
            }
            if (tx < 0 || rx < 0) {
                tsFail++;
                continue;
            }
            tsOk++;
            out.put(uid, new long[]{tx, rx});
        }
        return tsOk > 0 && tsFail < tsOk;
    }

    private Map<Integer, long[]> nsCache;
    private long nsCacheAt = 0L;

    /** 5 秒内复用上次结果，避免高频查询拖慢系统。 */
    private Map<Integer, long[]> readNetworkStatsCached() {
        long now = System.currentTimeMillis();
        if (nsCache != null && now - nsCacheAt < 5000L) {
            return nsCache;
        }
        nsCache = readNetworkStats(6L * 3600_000L);   // 关键：窗口要覆盖时间桶
        nsCacheAt = now;
        return nsCache;
    }

    /** 每种网络类型独立 try，避免一种失败拖垮全部。 */
    private Map<Integer, long[]> readNetworkStats(long windowMs) {
        if (nsm == null) {
            nsError = "no service";
            return null;
        }
        Map<Integer, long[]> out = new HashMap<>();
        long end = System.currentTimeMillis();
        long start = end - Math.max(windowMs, 5000);
        int[] types = new int[]{ConnectivityManager.TYPE_WIFI, ConnectivityManager.TYPE_MOBILE};
        StringBuilder err = new StringBuilder();
        boolean any = false;

        for (int type : types) {
            try {
                NetworkStats stats = nsm.queryDetails(type, null, start, end);
                NetworkStats.Bucket bucket = new NetworkStats.Bucket();
                while (stats.hasNextBucket()) {
                    stats.getNextBucket(bucket);
                    long[] v = out.get(bucket.getUid());
                    if (v == null) {
                        v = new long[]{0, 0};
                    }
                    v[0] += bucket.getTxBytes();
                    v[1] += bucket.getRxBytes();
                    out.put(bucket.getUid(), v);
                    any = true;
                }
                stats.close();
            } catch (SecurityException se) {
                err.append("type").append(type).append(":无权限 ");
            } catch (Exception e) {
                err.append("type").append(type).append(":").append(e.getClass().getSimpleName()).append(" ");
            }
        }
        nsError = err.toString().trim();
        return any ? out : null;
    }

    // ---------------------------------------------------------------- 自检

    /** 一次性探测，供界面上「自检」按钮调用。 */
    private boolean lastSourceIsNotShell() {
        return !"sh".equals(source);
    }

    public String probe() {
        StringBuilder sb = new StringBuilder();
        sb.append("使用情况访问：").append(hasUsageAccess() ? "✅" : "❌").append("\n");

        // 1) 自身 uid（这个一定支持）
        long selfTx = TrafficStats.getUidTxBytes(Process.myUid());
        sb.append("自身 TrafficStats：").append(selfTx < 0 ? "不可用" : selfTx + " B").append("\n");

        // 2) 其它应用抽样
        refreshApps();
        int ok = 0, bad = 0;
        long sum = 0;
        for (int i = 0; i < uidList.size() && i < 60; i++) {
            long v = TrafficStats.getUidTxBytes(uidList.get(i));
            if (v < 0) {
                bad++;
            } else {
                ok++;
                sum += v;
            }
        }
        sb.append("TrafficStats 抽样：支持 ").append(ok).append(" / 不支持 ").append(bad)
                .append("，合计 ").append(sum).append(" B\n");

        // 3) NetworkStats 两条通道（6 小时窗口 + 设备总量对照）
        long end = System.currentTimeMillis();
        long start6h = end - 6L * 3600_000L;
        for (int type : new int[]{ConnectivityManager.TYPE_WIFI, ConnectivityManager.TYPE_MOBILE}) {
            String name = type == ConnectivityManager.TYPE_WIFI ? "WiFi" : "移动网络";
            try {
                NetworkStats s = nsm.queryDetails(type, null, start6h, end);
                int n = 0;
                long bytes = 0;
                NetworkStats.Bucket b = new NetworkStats.Bucket();
                while (s.hasNextBucket()) {
                    s.getNextBucket(b);
                    n++;
                    bytes += b.getTxBytes() + b.getRxBytes();
                }
                s.close();
                long devBytes = -1;
                try {
                    NetworkStats.Bucket db = nsm.querySummaryForDevice(type, null, start6h, end);
                    devBytes = db.getTxBytes() + db.getRxBytes();
                } catch (Exception ignore) {
                }
                sb.append(name).append("：").append(n).append(" 条记录，").append(bytes)
                        .append(" B（设备总量 ").append(devBytes < 0 ? "?" : devBytes).append(" B）\n");
            } catch (Exception e) {
                sb.append(name).append("：").append(e.getClass().getSimpleName())
                        .append(" ").append(e.getMessage()).append("\n");
            }
        }
        sb.append("窗口：最近 6 小时 · 每 15 秒刷新\n应用数：").append(uidList.size());

        // 4) Shizuku(shell) 通道
        sb.append("\n——— Shizuku ———\n");
        sb.append(ShellNetStats.diag()).append("\n");
        String smp = ShellNetStats.sample();
        if (smp != null && !smp.isEmpty() && lastSourceIsNotShell()) {
            String head = smp.length() > 700 ? smp.substring(0, 700) : smp;
            sb.append("dumpsys 开头：\n").append(head).append("\n");
        }
        return sb.toString();
    }
}
