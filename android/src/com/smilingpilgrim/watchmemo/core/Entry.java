package com.smilingpilgrim.watchmemo.core;

import java.util.Locale;
import java.util.Map;

/** One saved memo. Persisted as one tab-separated line. */
public final class Entry {
    public String id = "", time = "", file = "", raw = "";
    public long t, size, crc, recMs = -1, audioMs = -1, watchAudioMs = -1, scrOffMs = -1, maxGapMs = -1;
    public int scrOff = -1, sats = -1, gpsWaitS = -1, packets;
    public double lat = Double.NaN, lon = Double.NaN, fixS = -1;
    public boolean fix, keepOn, truncated;
    public String stopKey = "", note = "";

    static final String[] COLS = {"id","time","file","raw","t","size","crc","recMs","audioMs","watchAudioMs","scrOffMs",
            "maxGapMs","scrOff","sats","gpsWaitS","packets","lat","lon","fixS","fix","keepOn","truncated","stopKey","note"};

    public String toLine() {
        Object[] v = {id,time,file,raw,t,size,crc,recMs,audioMs,watchAudioMs,scrOffMs,maxGapMs,scrOff,sats,gpsWaitS,packets,
                lat,lon,fixS,fix?1:0,keepOn?1:0,truncated?1:0,stopKey,note};
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < v.length; i++) {
            if (i > 0) sb.append('\t');
            sb.append(String.valueOf(v[i]).replace('\t', ' ').replace('\n', ' '));
        }
        return sb.toString();
    }

    public static Entry fromLine(String line) {
        String[] p = line.split("\t", -1);
        if (p.length < COLS.length) return null;
        Entry e = new Entry();
        int i = 0;
        e.id = p[i++]; e.time = p[i++]; e.file = p[i++]; e.raw = p[i++];
        e.t = l(p[i++]); e.size = l(p[i++]); e.crc = l(p[i++]); e.recMs = l(p[i++]); e.audioMs = l(p[i++]);
        e.watchAudioMs = l(p[i++]); e.scrOffMs = l(p[i++]); e.maxGapMs = l(p[i++]);
        e.scrOff = (int) l(p[i++]); e.sats = (int) l(p[i++]); e.gpsWaitS = (int) l(p[i++]); e.packets = (int) l(p[i++]);
        e.lat = d(p[i++]); e.lon = d(p[i++]); e.fixS = d(p[i++]);
        e.fix = "1".equals(p[i++]); e.keepOn = "1".equals(p[i++]); e.truncated = "1".equals(p[i++]);
        e.stopKey = p[i++]; e.note = p[i];
        return e;
    }

    /** Fill the watch-reported fields from the commit form. */
    public void fromForm(Map<String, String> f) {
        t = l(f.get("t"));
        recMs = l(f.get("recMs"));
        watchAudioMs = l(f.get("audioMs"));
        scrOff = (int) l(f.get("scrOff"));
        scrOffMs = l(f.get("scrOffMs"));
        maxGapMs = l(f.get("maxGapMs"));
        sats = (int) l(f.get("sats"));
        gpsWaitS = (int) l(f.get("gpsWaitS"));
        fix = "1".equals(f.get("fix"));
        lat = fix ? d(f.get("lat")) : Double.NaN;
        lon = fix ? d(f.get("lon")) : Double.NaN;
        if (fix && (Double.isNaN(lat) || Double.isNaN(lon))) fix = false;
        fixS = d(f.get("fixS")); if (Double.isNaN(fixS)) fixS = -1;
        keepOn = "1".equals(f.get("keepOn"));
        stopKey = s(f.get("stopKey"));
        note = s(f.get("note"));
    }

    static String s(String v) { return v == null || "undefined".equals(v) || "null".equals(v) ? "" : v; }
    static long l(String v) {
        try { return v == null ? -1 : (long) Double.parseDouble(v); } catch (Exception e) { return -1; }
    }
    static double d(String v) {
        try { return v == null || v.isEmpty() ? Double.NaN : Double.parseDouble(v); } catch (Exception e) { return Double.NaN; }
    }

    public String latLon() {
        return fix ? String.format(Locale.ROOT, "%.6f, %.6f", lat, lon) : "no fix";
    }
    public String mapUrl() {
        return fix ? String.format(Locale.ROOT, "https://maps.google.com/?q=%.6f,%.6f", lat, lon) : "";
    }
    public static String dur(long ms) {
        if (ms < 0) return "?";
        long s = Math.round(ms / 1000.0);
        return (s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
    }

    /** Did audio survive? Compares audio length with wall-clock recording time. */
    public String survived() {
        if (recMs <= 0 || audioMs < 0) return "?";
        double r = audioMs / (double) recMs;
        String ratio = Math.round(r * 100) + "%";
        if (scrOff > 0) return (r >= 0.9 ? "yes" : "NO") + " (screen went off " + scrOff + "x, audio " + ratio + ")";
        return (r >= 0.9 ? "screen stayed on, audio " : "screen stayed on, AUDIO SHORT ") + ratio;
    }
}
