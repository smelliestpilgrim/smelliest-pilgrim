package com.smilingpilgrim.watchmemo.core;

import java.util.HashMap;
import java.util.Map;

/**
 * When may a failed background lookup (Places: town names) be asked again?
 * A key is "in flight" from start() until done() or failed(). After failed() it may be asked again
 * once RETRY_MS has passed (the next day view after that asks again). After done() it is never
 * asked again in this process (the answer, possibly an empty "no town here", is cached by the caller).
 */
public final class RetryGate {
    /** 10 minutes: a phone that was offline on the trail usually has signal again by the next stop. */
    public static final long RETRY_MS = 10L * 60 * 1000;
    private final Map<String, Long> failedAt = new HashMap<>();
    private final java.util.Set<String> busy = new java.util.HashSet<>(), finished = new java.util.HashSet<>();

    /** True if the caller should start a lookup for key now (and it is then marked in flight). */
    public synchronized boolean start(String key, long now) {
        if (finished.contains(key) || busy.contains(key)) return false;
        Long f = failedAt.get(key);
        if (f != null && now - f < RETRY_MS) return false;
        busy.add(key);
        return true;
    }
    public synchronized void done(String key) { busy.remove(key); failedAt.remove(key); finished.add(key); }
    public synchronized void failed(String key, long now) { busy.remove(key); failedAt.put(key, now); }
}
