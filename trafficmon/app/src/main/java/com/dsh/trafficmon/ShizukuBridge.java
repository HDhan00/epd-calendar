package com.dsh.trafficmon;

import android.os.IBinder;
import android.os.ParcelFileDescriptor;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

import moe.shizuku.server.IRemoteProcess;
import moe.shizuku.server.IShizukuService;
import rikka.shizuku.Shizuku;
import rikka.shizuku.ShizukuBinderWrapper;

/**
 * Shizuku 桥接层（v3.2）
 *
 * 用 Shizuku 的服务以 shell（uid 2000）身份执行命令，从而读到
 * `dumpsys netstats detail` 这类普通应用拿不到的数据。
 *
 * 防御性设计（这是上次崩溃的教训）：
 *  - 每个入口都 try/catch，Shizuku 没装 / 没启动 / 没授权时一律返回 false
 *  - 任何异常都不允许冒泡到 Application.onCreate，否则就是启动即崩
 *  - 两个 binder 访问路径都试一遍（直连 / ShizukuBinderWrapper）
 */
public final class ShizukuBridge {

    /** 权限请求码，和 Shizuku 的回调里比对 */
    public static final int REQUEST_CODE = 0x5A1D;

    private static final Object LOCK = new Object();
    private static volatile String lastError = "";

    private ShizukuBridge() {
    }

    public static String lastError() {
        return lastError;
    }

    /** Shizuku 服务是否在运行 */
    public static boolean alive() {
        try {
            return Shizuku.pingBinder();
        } catch (Throwable t) {
            lastError = "pingBinder: " + t;
            return false;
        }
    }

    /** 是否已授予本应用 Shizuku 权限 */
    public static boolean granted() {
        try {
            return Shizuku.checkSelfPermission() == 0; // 0 == PERMISSION_GRANTED
        } catch (Throwable t) {
            lastError = "checkSelfPermission: " + t;
            return false;
        }
    }

    /** 弹 Shizuku 的授权框（需要在主线程调用） */
    public static void request() {
        try {
            Shizuku.requestPermission(REQUEST_CODE);
        } catch (Throwable t) {
            lastError = "requestPermission: " + t;
        }
    }

    /** 是否可用（服务在 + 已授权） */
    public static boolean ready() {
        return alive() && granted();
    }

    public static String status() {
        if (!alive()) {
            return "未连接（Shizuku 没运行 / 没安装）";
        }
        if (!granted()) {
            return "已连接，但本应用未获授权";
        }
        return "已授权";
    }

    /**
     * 以 shell 身份执行一条命令，返回 stdout。
     *
     * @param command   传给 /system/bin/sh -c 的命令
     * @param timeoutMs 超时，超时就 destroy 进程
     */
    public static String exec(String command, int timeoutMs) throws Exception {
        IBinder binder = Shizuku.getBinder();
        if (binder == null) {
            throw new IllegalStateException("Shizuku binder 为空");
        }

        IRemoteProcess proc = null;
        Exception first = null;

        // 路径 1：直连（provider 进程拿到的就是 IShizukuService）
        try {
            IShizukuService svc = IShizukuService.Stub.asInterface(binder);
            proc = svc.newProcess(new String[]{"/system/bin/sh", "-c", command}, null, null);
        } catch (Throwable t) {
            first = t instanceof Exception ? (Exception) t : new Exception(t);
        }

        // 路径 2：包一层 ShizukuBinderWrapper（非 provider 进程 / 容器 binder）
        if (proc == null) {
            try {
                IShizukuService svc = IShizukuService.Stub.asInterface(
                        new ShizukuBinderWrapper(binder));
                proc = svc.newProcess(new String[]{"/system/bin/sh", "-c", command}, null, null);
            } catch (Throwable t) {
                lastError = "newProcess 失败: " + t + (first != null ? " / " + first : "");
                throw new Exception(lastError);
            }
        }

        final ParcelFileDescriptor pfd = proc.getInputStream();
        final ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);

        Thread reader = new Thread(new Runnable() {
            @Override
            public void run() {
                InputStream is = null;
                try {
                    is = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
                    byte[] buf = new byte[16 * 1024];
                    int n;
                    while ((n = is.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        if (out.size() > 4 * 1024 * 1024) {
                            break; // 防止无限输出把内存吃光
                        }
                    }
                } catch (Throwable ignore) {
                } finally {
                    try {
                        if (is != null) is.close();
                    } catch (Throwable ignore) {
                    }
                }
            }
        }, "shizuku-stdout");
        reader.setDaemon(true);
        reader.start();

        try {
            boolean exited = proc.waitForTimeout(timeoutMs, "ms");
            if (!exited) {
                try {
                    proc.destroy();
                } catch (Throwable ignore) {
                }
            }
        } catch (Throwable ignore) {
        }

        reader.join(Math.min(3000, timeoutMs));
        synchronized (LOCK) {
            return out.toString("UTF-8");
        }
    }
}
