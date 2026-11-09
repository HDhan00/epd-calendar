package com.dsh.trafficmon;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;

import java.io.PrintWriter;
import java.io.StringWriter;

/** 崩溃兜底：把最近一次崩溃写进 SharedPreferences，下次启动可在「自检」里看到。 */
public class MyApp extends Application {

    public static final String PREF = "crash";
    public static final String KEY = "last";

    @Override
    public void onCreate() {
        super.onCreate();
        final Thread.UncaughtExceptionHandler def = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    StringWriter sw = new StringWriter();
                    e.printStackTrace(new PrintWriter(sw));
                    SharedPreferences sp = getSharedPreferences(PREF, Context.MODE_PRIVATE);
                    sp.edit().putString(KEY, sw.toString()).apply();
                } catch (Throwable ignore) {
                }
                if (def != null) {
                    def.uncaughtException(t, e);
                }
            }
        });
    }

    public static String lastCrash(Context c) {
        try {
            return c.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY, "");
        } catch (Throwable t) {
            return "";
        }
    }
}
