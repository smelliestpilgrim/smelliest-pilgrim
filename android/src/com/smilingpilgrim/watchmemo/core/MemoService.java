package com.smilingpilgrim.watchmemo.core;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.zip.CRC32;

/**
 * The three routes the Zepp Side Service calls:
 *   GET  /ping                         -> {"ok":true,"today":N}
 *   POST /chunk?id=&i=&n=   body=b64   -> {"ok":true,"i":i}
 *   POST /chunk?id=&i=&n=&o= body=b64  -> {"ok":true,"i":i,"o":o}   (0.2.2: by byte offset,
 *                                          so the watch may change chunk size mid-memo)
 *   POST /commit  form fields          -> {"ok":true,"size":..,"crc":..,"file":"HHMMSS.ogg"}
 * A memo only counts as saved once every chunk arrived, size and CRC match
 * what the watch computed, and the files were written.
 */
public final class MemoService {
    public interface Listener { void onSaved(Entry e, int today, boolean duplicate); void onLog(String line); }

    private final Library lib;
    private final Listener listener;
    private final Map<String, byte[][]> pending = new HashMap<>();
    /** 0.2.2: chunks stored by byte offset; a resend at the same offset overwrites. */
    private final Map<String, TreeMap<Long, byte[]>> pendingOff = new HashMap<>();
    private final TimeZone defaultTz;

    public MemoService(Library lib, TimeZone defaultTz, Listener l) {
        this.lib = lib; this.defaultTz = defaultTz; this.listener = l;
    }

    public Library library() { return lib; }

    public static final class Reply {
        public final int status; public final String json;
        Reply(int s, String j) { status = s; json = j; }
    }

    public synchronized Reply handle(String method, String path, Map<String, String> query, byte[] body) {
        try {
            if ("GET".equals(method) && "/ping".equals(path)) {
                return ok("\"today\":" + today().entries.size() + ",\"app\":\"WatchMemo\",\"ver\":\"" + Protocol.VERSION + "\",\"offsets\":true,\"maxChunk\":" + Protocol.MAX_CHUNK_BYTES);
            }
            if ("POST".equals(method) && "/chunk".equals(path)) return chunk(query, body);
            if ("POST".equals(method) && "/logpart".equals(path)) return logPart(query, body);
            if ("POST".equals(method) && "/commit".equals(path)) return commit(Http.parseForm(new String(body, StandardCharsets.UTF_8)));
            return err(404, "no route " + method + " " + path);
        } catch (Exception e) {
            log("error: " + e);
            return err(500, String.valueOf(e.getMessage()));
        }
    }

    private Reply chunk(Map<String, String> q, byte[] body) {
        String id = q.get("id");
        int i = parseInt(q.get("i")), n = parseInt(q.get("n"));
        if (id == null || !id.matches("\\d{1,16}")) return err(400, "bad id");
        if (q.get("o") != null) return chunkAt(id, i, Entry.l(q.get("o")), q.get("o"), body);
        if (n < 1 || n > Protocol.MAX_CHUNKS || i < 0 || i >= n) return err(400, "bad chunk index");
        byte[] data;
        try { data = Base64.getDecoder().decode(new String(body, StandardCharsets.US_ASCII).trim()); }
        catch (IllegalArgumentException e) { return err(400, "bad base64"); }
        byte[][] parts = pending.get(id);
        if (parts == null || parts.length != n) { parts = new byte[n][]; pending.put(id, parts); }
        parts[i] = data;
        return ok("\"i\":" + i);
    }

    private Reply chunkAt(String id, int i, long o, String rawO, byte[] body) {
        if (!rawO.matches("\\d{1,9}") || o < 0 || o >= Protocol.MAX_MEMO_BYTES) return err(400, "bad chunk offset");
        byte[] data;
        try { data = Base64.getDecoder().decode(new String(body, StandardCharsets.US_ASCII).trim()); }
        catch (IllegalArgumentException e) { return err(400, "bad base64"); }
        if (data.length == 0) return err(400, "empty chunk");
        if (data.length > Protocol.MAX_CHUNK_BYTES) return err(413, "chunk too big: " + data.length);
        TreeMap<Long, byte[]> parts = pendingOff.get(id);
        if (parts == null) { parts = new TreeMap<>(); pendingOff.put(id, parts); }
        parts.put(o, data);
        return ok("\"i\":" + i + ",\"o\":" + o + ",\"len\":" + data.length);
    }

    /** Walks the offset store from byte 0: each next part must start where the last ended. Stale parts off the path are ignored. */
    static byte[] assemble(TreeMap<Long, byte[]> parts, long size, StringBuilder problem) {
        if (size < 0 || size > Protocol.MAX_MEMO_BYTES) { problem.append("bad size ").append(size); return null; }
        byte[] raw = new byte[(int) size];
        long at = 0;
        while (at < size) {
            byte[] p = parts.get(at);
            if (p == null) { problem.append("missing bytes from offset ").append(at); return null; }
            if (at + p.length > size) { problem.append("size/crc mismatch: chunk at ").append(at).append(" runs past the end (").append(size).append(")"); return null; }
            System.arraycopy(p, 0, raw, (int) at, p.length);
            at += p.length;
        }
        return raw;
    }

    private final Map<String, byte[][]> logs = new HashMap<>();

    /** The watch's breadcrumb log, in base64 parts; saved as watch-log-HHMMSS.txt when complete. */
    private Reply logPart(Map<String, String> q, byte[] body) throws IOException {
        String id = q.get("id");
        int i = parseInt(q.get("i")), n = parseInt(q.get("n"));
        if (id == null || !id.matches("\\d{1,16}")) return err(400, "bad id");
        if (n < 1 || n > 512 || i < 0 || i >= n) return err(400, "bad part index");
        byte[] data;
        try { data = Base64.getDecoder().decode(new String(body, StandardCharsets.US_ASCII).trim()); }
        catch (IllegalArgumentException e) { return err(400, "bad base64"); }
        byte[][] parts = logs.get(id);
        if (parts == null || parts.length != n) { parts = new byte[n][]; logs.put(id, parts); }
        parts[i] = data;
        int total = 0;
        for (byte[] p : parts) { if (p == null) return ok("\"i\":" + i + ",\"done\":false"); total += p.length; }
        byte[] all = new byte[total];
        int o = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, all, o, p.length); o += p.length; }
        logs.remove(id);
        long now = System.currentTimeMillis();
        String day = fmt("yyyy-MM-dd", now, defaultTz);
        String name = "watch-log-" + fmt("HHmmss", now, defaultTz) + ".txt";
        for (int k = 2; lib.audio(day, name).exists(); k++) name = "watch-log-" + fmt("HHmmss", now, defaultTz) + "-" + k + ".txt";
        Library.writeAtomic(lib.audio(day, name), all);
        rebuild(day);
        log("saved watch log " + name + " (" + all.length + " bytes) into " + Library.zipName(day));
        return ok("\"i\":" + i + ",\"done\":true,\"file\":" + Http.q(name));
    }

    private Reply commit(Map<String, String> f) throws IOException {
        String id = f.get("id");
        if (id == null || !id.matches("\\d{1,16}")) return err(400, "bad id");
        long wantSize = Entry.l(f.get("size")), wantCrc = Entry.l(f.get("crc"));
        Entry probe = new Entry();
        probe.fromForm(f);
        if (probe.t <= 0) probe.t = Long.parseLong(id);
        TimeZone tz = tzFor(f.get("tz"));
        String day = fmt("yyyy-MM-dd", probe.t, tz);
        DayLog log = lib.day(day);

        Entry prev = log.find(id);
        if (prev != null) { // already saved (e.g. the watch never got our first reply)
            pending.remove(id);
            pendingOff.remove(id);
            if (prev.size == wantSize && prev.crc == wantCrc) {
                log("memo " + prev.file + " arrived again, already saved");
                if (listener != null) listener.onSaved(prev, today().entries.size(), true);
                return okSaved(prev, true);
            }
            return err(409, "memo id already saved with different content");
        }

        byte[] raw;
        TreeMap<Long, byte[]> offParts = pendingOff.get(id);
        if (offParts != null && ("o".equals(f.get("mode")) || pending.get(id) == null)) {
            StringBuilder problem = new StringBuilder();
            raw = assemble(offParts, wantSize, problem);
            if (raw == null) {
                if (problem.toString().startsWith("size/crc mismatch")) pendingOff.remove(id);
                return err(409, problem.toString());
            }
        } else {
            byte[][] parts = pending.get(id);
            if (parts == null) return err(409, "no chunks received for this memo");
            StringBuilder missing = new StringBuilder();
            int total = 0;
            for (int k = 0; k < parts.length; k++) {
                if (parts[k] == null) { if (missing.length() < 60) missing.append(missing.length() > 0 ? "," : "").append(k); }
                else total += parts[k].length;
            }
            if (missing.length() > 0) return err(409, "missing chunks " + missing);
            raw = new byte[total];
            int o = 0;
            for (byte[] p : parts) { System.arraycopy(p, 0, raw, o, p.length); o += p.length; }
        }
        CRC32 c = new CRC32(); c.update(raw, 0, raw.length);
        if (raw.length != wantSize || c.getValue() != wantCrc) {
            pending.remove(id);
            pendingOff.remove(id);
            return err(409, "size/crc mismatch: got " + raw.length + "/" + c.getValue() + ", watch said " + wantSize + "/" + wantCrc);
        }

        String hms = fmt("HHmm-ss", probe.t, tz);
        String name = hms + ".ogg";
        for (int k = 2; log.nameTaken(name) || lib.audio(day, name).exists(); k++) name = hms + "-" + k + ".ogg";

        ZeppOpus.Parsed parsed = ZeppOpus.parse(raw);
        Entry e = probe;
        e.id = id; e.size = raw.length; e.crc = c.getValue();
        e.time = fmt("HH:mm:ss", probe.t, tz);
        e.packets = parsed.packets.size();
        e.audioMs = parsed.durationMs();
        e.truncated = parsed.truncated();

        // Raw first, privately: whatever happens to the conversion, the exact watch bytes are safe.
        File rawF = lib.rawFile(id);
        Library.writeAtomic(rawF, raw);
        String problem = null;
        if (parsed.packets.isEmpty()) problem = "no Opus packets found";
        else {
            try {
                byte[] ogg = OggOpus.build(parsed.packets, 16000, (int) (Long.parseLong(id) & 0x7fffffff), day + " " + e.time);
                OggCheck.Info info = OggCheck.check(ogg);
                if (info.audioPackets != parsed.packets.size()) throw new IOException("Ogg has " + info.audioPackets + " packets, expected " + parsed.packets.size());
                File af = lib.audio(day, name);
                Library.writeAtomic(af, ogg);
                byte[] back = java.nio.file.Files.readAllBytes(af.toPath());
                if (back.length != ogg.length || Library.crc(back) != Library.crc(ogg)) throw new IOException("saved .ogg reads back different");
                e.file = name;
            } catch (Exception ex) { problem = "conversion failed: " + ex.getMessage(); }
        }
        if (problem == null) {
            rawF.delete(); // verified: size/CRC matched the watch, Ogg repack checked, file reads back identical
            e.raw = "";
        } else {
            e.file = "(no audio)";
            e.raw = rawF.getName();
            e.note = (e.note.isEmpty() ? "" : e.note + "; ") + problem + "; watch bytes kept inside the app";
        }
        log.add(e);
        pending.remove(id);
        pendingOff.remove(id);
        rebuild(day);
        log("saved " + e.file + " (" + Entry.dur(e.audioMs) + ", " + (e.fix ? "GPS ok" : "no GPS") + ")");
        if (listener != null) listener.onSaved(e, today().entries.size(), false);
        return okSaved(e, false);
    }

    /** The memo is already safe in private storage; a zip problem must not make the watch resend. */
    private void rebuild(String day) {
        try { lib.rebuild(day); } catch (Exception ex) { log("zip for " + day + " not rebuilt: " + ex.getMessage() + " (retried next launch)"); }
    }

    public synchronized DayLog today() {
        return lib.day(fmt("yyyy-MM-dd", System.currentTimeMillis(), defaultTz));
    }

    private TimeZone tzFor(String minutes) {
        long m = Entry.l(minutes);
        if (minutes == null || m < -14 * 60 || m > 14 * 60) return defaultTz;
        // Prefer the phone's zone when it agrees (keeps DST names); else use the watch offset.
        if (defaultTz.getOffset(System.currentTimeMillis()) == m * 60000) return defaultTz;
        return new SimpleTimeZone((int) (m * 60000), "watch");
    }

    public static String fmt(String pattern, long t, TimeZone tz) {
        SimpleDateFormat f = new SimpleDateFormat(pattern, Locale.ROOT);
        f.setTimeZone(tz);
        return f.format(new Date(t));
    }

    private Reply okSaved(Entry e, boolean dup) {
        return ok("\"size\":" + e.size + ",\"crc\":" + e.crc + ",\"file\":" + Http.q(e.file) + ",\"dup\":" + dup);
    }
    private static Reply ok(String fields) { return new Reply(200, "{\"ok\":true" + (fields.isEmpty() ? "" : "," + fields) + "}"); }
    private Reply err(int status, String msg) {
        log("refused: " + msg);
        return new Reply(status, "{\"ok\":false,\"error\":" + Http.q(msg) + "}");
    }
    private void log(String s) { if (listener != null) listener.onLog(s); }
    private static int parseInt(String s) { try { return Integer.parseInt(s); } catch (Exception e) { return -1; } }
}
