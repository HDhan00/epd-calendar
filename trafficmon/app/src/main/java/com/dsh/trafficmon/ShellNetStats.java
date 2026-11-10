package com.dsh.trafficmon;

import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 通过 Shizuku 以 shell 身份读取 `dumpsys netstats detail`，解析出 per-uid 累计字节数。
 *
 * 为什么用 dumpsys：
 *  - 非系统应用调用 TrafficStats.getUid*Bytes(其他 uid) 在 Android 10+ 多数返回 UNSUPPORTED；
 *  - NetworkStatsManager 需要「使用情况访问」权限，而且粒度受桶大小限制；
 *  - shell 身份跑 dumpsys 能拿到 service 内部累计计数，这是最接近"实时"的免费途径。
 *
 * 解析策略（刻意写得宽松）：不同 ROM/Android 版本的 dumpsys 排版并不统一，
 * 所以采用「记住最近的 uid=，然后在该行及后续行里累积 rx/tx 数字」的方式，
 * 只要出现 uid 与字节数就能凑出来。解析不出来就返回空，让上层回落到别的通道。
 */
public final class ShellNetStats {

    /** 结果缓存时间：dumpsys 输出可能很大，不宜每 15 秒都跑 */
    private static final long CACHE_MS = 20_000L;
    private static final int MAX_SAMPLE = 1500;

    private static Map<Integer, long[]> cache;
    private static long cacheAt = 0L;
    private static String lastError = "";
    private static String lastSample = "";
    private static long lastParseMs = 0L;
    private static int lastRawLen = 0;

    private static final Pattern UID = Pattern.compile("uid[=:\\s]+(\\d{2,10})");
    private static final Pattern RX = Pattern.compile("(?:rxBytes|rx_bytes|rx)[=:\\s]+(\\d{1,16})");
    private static final Pattern TX = Pattern.compile("(?:txBytes|tx_bytes|tx)[=:\\s]+(\\d{1,16})");

    private ShellNetStats() {
    }

    public static synchronized Map<Integer, long[]> read() {
        long now = System.currentTimeMillis();
        if (cache != null && now - cacheAt < CACHE_MS) {
            return cache;
        }
        if (!ShizukuBridge.ready()) {
            lastError = "Shizuku 不可用：" + ShizukuBridge.status();
            return null;
        }

        String out = null;
        try {
            out = ShizukuBridge.exec("dumpsys netstats detail", 8000);
        } catch (Throwable t) {
            lastError = "执行 dumpsys 失败：" + t.getMessage();
            return null;
        }

        long t0 = System.currentTimeMillis();
        Map<Integer, long[]> parsed = parse(out);
        lastParseMs = System.currentTimeMillis() - t0;
        lastRawLen = out == null ? 0 : out.length();
        lastSample = out == null ? "" : (out.length() > MAX_SAMPLE ? out.substring(0, MAX_SAMPLE) : out);

        if (parsed.isEmpty()) {
            lastError = "拿到 " + lastRawLen + " 字符但没解析出 uid 数据";
            return null;
        }

        lastError = "";
        cache = parsed;
        cacheAt = now;
        return cache;
    }

    /** 解析 dumpsys 输出。返回 uid → {txBytes, rxBytes} */
    static Map<Integer, long[]> parse(String out) {
        Map<Integer, long[]> m = new HashMap<>();
        if (out == null || out.isEmpty()) {
            return m;
        }

        int uid = -1;
        for (String line : out.split("\n")) {
            Matcher mu = UID.matcher(line);
            if (mu.find()) {
                try {
                    uid = Integer.parseInt(mu.group(1));
                } catch (NumberFormatException e) {
                    uid = -1;
                }
            }
            if (uid < 0) {
                continue;
            }

            long tx = firstLong(TX, line);
            long rx = firstLong(RX, line);
            if (tx < 0 && rx < 0) {
                continue;
            }
            long[] e = m.get(uid);
            if (e == null) {
                e = new long[]{0L, 0L};
                m.put(uid, e);
            }
            if (tx > 0) {
                e[0] += tx;
            }
            if (rx > 0) {
                e[1] += rx;
            }
        }
        return m;
    }

    private static long firstLong(Pattern p, String line) {
        Matcher m = p.matcher(line);
        if (!m.find()) {
            return -1;
        }
        try {
            return Long.parseLong(m.group(1));
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** 自检用的一行摘要 */
    public static synchronized String diag() {
        StringBuilder sb = new StringBuilder();
        sb.append("shell: ").append(ShizukuBridge.status());
        if (lastRawLen > 0) {
            sb.append(" | dumpsys ").append(lastRawLen).append(" 字符");
            sb.append(", 解析 ").append(lastParseMs).append("ms");
            sb.append(", uid ").append(cache == null ? 0 : cache.size()).append(" 个");
        }
        if (!lastError.isEmpty()) {
            sb.append("\n  ! ").append(lastError);
        }
        return sb.toString();
    }

    /** 解析失败时，把 dumpsys 的开头一段给出来，方便对着真实格式调解析器 */
    public static synchronized String sample() {
        return lastSample;
    }

    public static synchronized void invalidate() {
        cache = null;
        cacheAt = 0L;
    }
}
