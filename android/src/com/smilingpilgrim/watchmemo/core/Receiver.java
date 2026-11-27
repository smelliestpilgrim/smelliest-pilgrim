package com.smilingpilgrim.watchmemo.core;

import java.util.TimeZone;

/**
 * 0.2.4 (item 12, option A): owns the library, MemoService and the 127.0.0.1 server for the
 * whole process, not for one Activity. It is held by App (the Application), so the receiver
 * keeps running when MainActivity is destroyed (BACK, rotation, the system dropping the
 * Activity) and stops only when Android ends the process. There is no foreground service; a
 * swipe-away from Recents or a process kill still stops it.
 * The Activity attaches as the Ui while it exists; with no Activity, memos are still saved.
 * Pure Java, so it is tested on the JVM (test/FixTests.java, #12).
 */
public final class Receiver implements MemoService.Listener {
    public interface Ui extends MemoService.Listener { void onState(); }
    public interface Startup { void run(Receiver rx) throws Exception; }

    private final Library lib;
    private final MemoService service;
    private final int port;
    private final MemoService.Listener sysLog;
    private volatile Ui ui;
    private volatile String state = "Starting…";
    private volatile boolean ready = false;
    private volatile int sessionCount = 0;
    private boolean started = false;
    private Http http;

    public Receiver(Library lib, TimeZone tz, int port, MemoService.Listener sysLog) {
        this.lib = lib; this.port = port; this.sysLog = sysLog;
        this.service = new MemoService(lib, tz, this);
    }

    public Library lib() { return lib; }
    public MemoService service() { return service; }
    public String state() { return state; }
    public boolean ready() { return ready; }
    public int sessionCount() { return sessionCount; }
    public synchronized boolean running() { return http != null; }

    public void attach(Ui u) { ui = u; }
    /** Only the Activity that is attached can detach (a new one may have attached already). */
    public void detach(Ui u) { if (ui == u) ui = null; }

    public void setState(String s) { state = s; Ui u = ui; if (u != null) u.onState(); }

    /** Runs the startup work (import, heal), then opens the server. Only the first call does anything. */
    public synchronized void start(final Startup startup) {
        if (started) return;
        started = true;
        new Thread(() -> {
            try { if (startup != null) startup.run(this); } catch (Exception e) { onLog("startup: " + e); }
            ready = true;
            Http h = new Http(service, port);
            String s;
            try { h.start(); synchronized (this) { http = h; } s = "Receiver ready"; }
            catch (Exception e) { s = "RECEIVER FAILED: " + e.getMessage() + " – close the app from Recents and reopen"; }
            setState(s);
        }, "startup").start();
    }

    /** For tests (and a future explicit "stop receiver"): closes the server. */
    public synchronized void stop() { if (http != null) { http.stop(); http = null; } }

    @Override public void onSaved(Entry e, int today, boolean duplicate) {
        if (!duplicate) sessionCount++;
        Ui u = ui;
        if (u != null) u.onSaved(e, today, duplicate);
    }

    @Override public void onLog(String line) {
        if (sysLog != null) sysLog.onLog(line);
        Ui u = ui;
        if (u != null) u.onLog(line);
    }
}
