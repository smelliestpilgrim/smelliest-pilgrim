import com.smilingpilgrim.watchmemo.core.*;
import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.CRC32;

/**
 * Tests for the 27 Nov 2026 fixes (FIXES.md items 9, 13-20). New hooks are reached by
 * reflection so this file also compiles against 0.2.3 and shows which tests fail there.
 * usage: java -cp <classes> FixTests <synthetic data dir> <work dir> [real .ogg dir]
 */
public class FixTests {
    static int pass = 0, fail = 0;
    static void ok(boolean c, String m) { if (c) { pass++; System.out.println("  ok   " + m); } else { fail++; System.out.println("  FAIL " + m); } }
    static void test(String name, Callable t) { try { t.run(); } catch (Throwable e) { fail++; System.out.println("  FAIL " + name + " -- " + e); } }
    interface Callable { void run() throws Exception; }
    static final TimeZone MADRID = TimeZone.getTimeZone("Europe/Madrid");
    static File data, work;
    static final List<String> logs = Collections.synchronizedList(new ArrayList<>());

    static MemoService service(File dir) {
        Library lib = new Library(new File(dir, "state"), new FileShared(new File(dir, "docs/WatchMemos")), logs::add);
        return new MemoService(lib, MADRID, new MemoService.Listener() {
            public void onSaved(Entry e, int today, boolean dup) {}
            public void onLog(String s) { logs.add(s); }
        });
    }
    static Object call(Object o, String m, Class<?>[] types, Object... args) throws Exception {
        Class<?> c = o instanceof Class ? (Class<?>) o : o.getClass();
        Method x = c.getDeclaredMethod(m, types); x.setAccessible(true);
        try { return x.invoke(o instanceof Class ? null : o, args); } catch (InvocationTargetException e) { throw (Exception) e.getCause(); }
    }
    static MemoService.Reply chunkAt(MemoService s, String id, byte[] raw, int from, int to) {
        Map<String, String> q = new HashMap<>(); q.put("id", id); q.put("i", "0"); q.put("n", "1"); q.put("o", "" + from);
        return s.handle("POST", "/chunk", q, Base64.getEncoder().encode(Arrays.copyOfRange(raw, from, to)));
    }
    static MemoService.Reply commit(MemoService s, String id, byte[] raw) {
        CRC32 c = new CRC32(); c.update(raw);
        String f = "id=" + id + "&t=" + id + "&size=" + raw.length + "&crc=" + c.getValue() + "&tz=60&fix=0&mode=o&recMs=1000&stopKey=SELECT";
        return s.handle("POST", "/commit", new HashMap<>(), f.getBytes(StandardCharsets.UTF_8));
    }
    static MemoService.Reply sendAll(MemoService s, String id, byte[] raw, int cs) {
        for (int o = 0; o < raw.length; o += cs) { MemoService.Reply r = chunkAt(s, id, raw, o, Math.min(raw.length, o + cs)); if (r.status != 200) return r; }
        return commit(s, id, raw);
    }
    static int pending(MemoService s) throws Exception { return (Integer) call(s, "pendingCount", new Class<?>[0]); }

    public static void main(String[] a) throws Exception {
        data = new File(a[0]); work = new File(a[1]); work.mkdirs();
        byte[] m20 = Files.readAllBytes(new File(data, "m20.zeppopus").toPath());
        byte[] lng = Files.readAllBytes(new File(data, "long.zeppopus").toPath());

        System.out.println("== #9 version");
        test("#9", () -> {
            MemoService s = service(new File(work, "v"));
            String j = s.handle("GET", "/ping", new HashMap<>(), new byte[0]).json;
            ok(j.contains("\"ver\":\"0.2.4\"") && j.contains("\"app\":\"WatchMemo\"") && j.contains("\"offsets\":true"), "#9 /ping reports ver 0.2.4 (app id string unchanged): " + j);
        });

        System.out.println("== #13 pending chunks expire after " + "30 min idle");
        test("#13", () -> {
            MemoService s = service(new File(work, "p"));
            final long[] now = {1795000000000L};
            call(s, "setClock", new Class<?>[]{java.util.function.LongSupplier.class}, (java.util.function.LongSupplier) () -> now[0]);
            String id = "1795000000000";
            ok(sendAll(s, id, m20, 16384).status == 200 && pending(s) == 0, "#13 normal send saved, nothing left pending");
            String b = "1795000060000";
            chunkAt(s, b, lng, 0, 16384); chunkAt(s, b, lng, 16384, 32768);
            now[0] += 29 * 60000L; s.handle("GET", "/ping", new HashMap<>(), new byte[0]);
            ok(pending(s) == 1, "#13 29 min idle: parts kept (a resume still joins them)");
            MemoService.Reply r = null;
            for (int o = 32768; o < lng.length; o += 5000) r = chunkAt(s, b, lng, o, Math.min(lng.length, o + 5000));
            r = commit(s, b, lng);
            ok(r.status == 200 && r.json.contains("\"dup\":false"), "#13 resume after 29 min with another chunk size: saved, CRC matched: " + r.json);
            String c = "1795000120000";
            chunkAt(s, c, lng, 0, 16384); chunkAt(s, c, lng, 16384, 32768);
            now[0] += 31 * 60000L; s.handle("GET", "/ping", new HashMap<>(), new byte[0]);
            ok(pending(s) == 0 && logs.stream().anyMatch(x -> x.contains("dropped unfinished upload " + c)), "#13 31 min idle: parts dropped and logged");
            for (int o = 32768; o < lng.length; o += 16384) chunkAt(s, c, lng, o, Math.min(lng.length, o + 16384));
            r = commit(s, c, lng);
            ok(r.status == 409 && r.json.contains("missing bytes from offset 0"), "#13 a late resume is refused with 'missing bytes' (watch then restarts from byte 0): " + r.json);
            r = sendAll(s, c, lng, 16384);
            ok(r.status == 200, "#13 restart from chunk 0 after expiry: saved: " + r.json);
            // retry: same chunk sent twice (lost reply) still fine
            String d = "1795000180000";
            chunkAt(s, d, m20, 0, 4096); chunkAt(s, d, m20, 0, 4096);
            for (int o = 4096; o < m20.length; o += 4096) chunkAt(s, d, m20, o, Math.min(m20.length, o + 4096));
            ok(commit(s, d, m20).status == 200, "#13 retry (same chunk twice) still saved");
        });

        System.out.println("== #14 / #15 HTTP server");
        test("#14/#15", () -> {
            MemoService s = service(new File(work, "h"));
            int port = 18900 + new Random().nextInt(90);
            Http h = new Http(s, port); h.start();
            try {
                List<Socket> idle = new ArrayList<>();
                for (int i = 0; i < 50; i++) idle.add(new Socket("127.0.0.1", port));
                Thread.sleep(500);
                long conn = Thread.getAllStackTraces().keySet().stream().filter(t -> t.getName().equals("watchmemo-conn")).count();
                int busy = 0;
                for (Socket k : idle) {
                    k.setSoTimeout(300);
                    try { byte[] b = new byte[64]; int n = k.getInputStream().read(b); if (n > 0 && new String(b, 0, n, StandardCharsets.US_ASCII).startsWith("HTTP/1.1 503")) busy++; } catch (SocketTimeoutException ignored) {}
                }
                ok(conn <= 8, "#14 50 idle connections -> " + conn + " server threads (limit 8)");
                ok(busy >= 42, "#14 connections over the limit answered 503 at once: " + busy + " of 50");
                for (Socket k : idle) k.close();
                Thread.sleep(300);
                ok(raw(port, "GET /ping HTTP/1.1\r\n\r\n").startsWith("HTTP/1.1 200"), "#14 after the flood a normal /ping works");
                String bad = raw(port, "POST /chunk?id=1&i=0&n=1 HTTP/1.1\r\nContent-Length: 12abc\r\n\r\nAAAA");
                ok(bad.startsWith("HTTP/1.1 400") && bad.contains("bad content-length"), "#15 malformed Content-Length -> 400 bad content-length: " + bad.replace("\r\n", " | "));
                ok(logs.stream().anyMatch(x -> x.contains("bad Content-Length")), "#15 ... and it is logged");
                String big = raw(port, "POST /chunk?id=1&i=0&n=1 HTTP/1.1\r\nContent-Length: 99999999999\r\n\r\n");
                ok(big.startsWith("HTTP/1.1 400"), "#15 overflowing Content-Length -> 400 too");
            } finally { h.stop(); }
        });

        System.out.println("== #16 OggCheck");
        test("#16", () -> {
            List<byte[]> pk = ZeppOpus.parse(m20).packets;
            byte[] ogg = OggOpus.build(pk, 16000, 12345, "t");
            OggCheck.Info i = OggCheck.check(ogg);
            Field ch = OggCheck.Info.class.getField("channels"), ps = OggCheck.Info.class.getField("preSkip"), ir = OggCheck.Info.class.getField("inputRate");
            ok(ch.getInt(i) == 1 && ps.getInt(i) == 312 && ir.getLong(i) == 16000, "#16 OggOpus.build output passes and reports 1 ch, pre-skip 312, 16000 Hz");
            int[] pages = pages(ogg);
            ok(pages.length >= 4, "#16 test file has " + pages.length + " pages");
            Object[][] bad = {
                {"OpusHead version 16", mut(ogg, pages[0] + 28 + 8, 16)},
                {"OpusHead 0 channels", mut(ogg, pages[0] + 28 + 9, 0)},
                {"OpusHead family 0 with 3 channels", mut(ogg, pages[0] + 28 + 9, 3)},
                {"serial changes on page 2", mutLe32(ogg, pages[2] + 14, 999)},
                {"page sequence skips (page 2 says 5)", mutLe32(ogg, pages[2] + 18, 5)},
                {"a whole audio page missing", drop(ogg, pages[2], pages[3])},
            };
            for (Object[] b : bad) {
                String why = null;
                try { OggCheck.check((byte[]) b[1]); } catch (IllegalArgumentException e) { why = e.getMessage(); }
                ok(why != null, "#16 refused, CRC valid but " + b[0] + ": " + why);
            }
            if (a.length > 2) {
                int n = 0, bad2 = 0;
                for (File f : listOgg(new File(a[2]))) { n++; try { OggCheck.check(Files.readAllBytes(f.toPath())); } catch (IllegalArgumentException e) { bad2++; System.out.println("    rejected " + f + ": " + e.getMessage()); } }
                ok(n > 0 && bad2 == 0, "#16 none of James's " + n + " real field .ogg memos is rejected by the stricter check");
            }
        });

        System.out.println("== #17 duplicate MediaStore rows");
        test("#17", () -> {
            Class<?> sf = SharedFolder.class;
            ok((Integer) call(sf, "newest", new Class<?>[]{long[].class}, (Object) new long[]{41, 97, 63}) == 1, "#17 newest of ids 41,97,63 is 97 (index 1)");
            ok((Integer) call(sf, "newest", new Class<?>[]{long[].class}, (Object) new long[]{97, 63, 41}) == 0, "#17 ... whatever the query order");
            ok((Integer) call(sf, "newest", new Class<?>[]{long[].class}, (Object) new long[0]) == -1, "#17 none -> -1");
        });

        System.out.println("== #18 Places retry gate");
        test("#18", () -> {
            Class<?> g = Class.forName("com.smilingpilgrim.watchmemo.core.RetryGate");
            Object r = g.getConstructor().newInstance();
            Class<?>[] SL = {String.class, long.class};
            long t = 1000000L;
            ok((Boolean) call(r, "start", SL, "a", t), "#18 first view asks");
            ok(!(Boolean) call(r, "start", SL, "a", t + 1), "#18 not twice while in flight");
            call(r, "failed", SL, "a", t + 2);
            ok(!(Boolean) call(r, "start", SL, "a", t + 9 * 60000L), "#18 failed lookup not hammered: 9 min later, no");
            ok((Boolean) call(r, "start", SL, "a", t + 10 * 60000L + 2), "#18 failed lookup is asked again after 10 min (next day view)");
            call(r, "done", new Class<?>[]{String.class}, "a");
            ok(!(Boolean) call(r, "start", SL, "a", t + 999 * 60000L), "#18 an answer (even an empty 'no town here') is never re-asked");
        });

        System.out.println("== #19 Migration.newName");
        test("#19", () -> {
            File d = new File(work, "m"); Library lib = new Library(new File(d, "state"), new FileShared(new File(d, "docs/WatchMemos")), logs::add);
            Migration mg = new Migration(lib, MADRID, null);
            DayLog dl = lib.day("2026-11-14");
            Class<?>[] T = {String.class, String.class, DayLog.class, String.class};
            Object n1 = call(mg, "newName", T, null, "143205.ogg", dl, "2026-11-14");
            Object n2 = call(mg, "newName", T, null, "143205-2.ogg", dl, "2026-11-14");
            Object n3 = call(mg, "newName", T, "14:32:05", "143205-2.ogg", dl, "2026-11-14");
            Object n4 = call(mg, "newName", T, null, "memo.ogg", dl, "2026-11-14");
            ok("1432-05.ogg".equals(n1), "#19 0.1.x HHMMSS.ogg -> " + n1);
            ok("1432-05-2.ogg".equals(n2), "#19 0.1.x HHMMSS-k.ogg (the -k form) -> " + n2 + " (HHMM-SS-k, same as the phone's own -k names)");
            ok("1432-05.ogg".equals(n3), "#19 with the time from day.md -> " + n3);
            ok("memo.ogg".equals(n4), "#19 a non-time name is left alone -> " + n4);
        });

        System.out.println("== #20 short TSV lines / unreadable day file");
        test("#20", () -> {
            File d = new File(work, "t"); Library lib = new Library(new File(d, "state"), new FileShared(new File(d, "docs/WatchMemos")), logs::add);
            MemoService s = new MemoService(lib, MADRID, null);
            ok(sendAll(s, "1794663125000", m20, 16384).status == 200, "#20 setup: one memo saved on 2026-11-14");
            File tsv = new File(lib.daysDir, "2026-11-14.tsv");
            String good = new String(Files.readAllBytes(tsv.toPath()), StandardCharsets.UTF_8);
            String shortLine = "1794663000000\t14:30:00\t1430-00.ogg\tcut-short-by-a-crash";
            Files.write(tsv.toPath(), (good + shortLine + "\n").getBytes(StandardCharsets.UTF_8));
            logs.clear();
            DayLog dl = lib.day("2026-11-14");
            ok(dl.entries.size() == 1, "#20 the day still loads: 1 memo shown");
            ok(logs.stream().anyMatch(x -> x.contains("2026-11-14.tsv line 2 has 4 of " + 24 + " columns")), "#20 the short line is logged with day, line number and reason: " + logs);
            ok(sendAll(s, "1794663185000", lng, 16384).status == 200, "#20 a new memo is still saved that day");
            String after = new String(Files.readAllBytes(tsv.toPath()), StandardCharsets.UTF_8);
            ok(after.contains(shortLine + "\n") && lib.day("2026-11-14").entries.size() == 2, "#20 the short line is kept byte for byte in the .tsv after the rewrite (not deleted, not repaired)");
            // unreadable file: never overwritten
            byte[] before = Files.readAllBytes(tsv.toPath());
            tsv.setReadable(false);
            try {
                logs.clear();
                MemoService.Reply r = sendAll(new MemoService(lib, MADRID, null), "1794663245000", m20, 16384);
                tsv.setReadable(true);
                ok(r.status == 500 && Arrays.equals(Files.readAllBytes(tsv.toPath()), before), "#20 day file unreadable -> commit answers 500 (watch keeps the memo and retries) and the .tsv is NOT overwritten: " + r.json);
                ok(logs.stream().anyMatch(x -> x.contains("could not read 2026-11-14.tsv")), "#20 the load error is logged");
            } finally { tsv.setReadable(true); }
        });

        System.out.println("== #12 receiver outlives the Activity (option A: owned by App, no Service)");
        test("#12", () -> {
            Class<?> rc = Class.forName("com.smilingpilgrim.watchmemo.core.Receiver");
            Class<?> uiC = Class.forName("com.smilingpilgrim.watchmemo.core.Receiver$Ui");
            Class<?> stC = Class.forName("com.smilingpilgrim.watchmemo.core.Receiver$Startup");
            File d = new File(work, "rx");
            Library lib = new Library(new File(d, "state"), new FileShared(new File(d, "docs/WatchMemos")), logs::add);
            int port = 18990 + new Random().nextInt(9);
            Object rx = rc.getConstructor(Library.class, TimeZone.class, int.class, MemoService.Listener.class).newInstance(lib, MADRID, port, null);
            final int[] savedA = {0}, savedB = {0}, starts = {0};
            Object uiA = java.lang.reflect.Proxy.newProxyInstance(uiC.getClassLoader(), new Class<?>[]{uiC}, (pr, m, ar) -> { if (m.getName().equals("onSaved")) savedA[0]++; return null; });
            Object uiB = java.lang.reflect.Proxy.newProxyInstance(uiC.getClassLoader(), new Class<?>[]{uiC}, (pr, m, ar) -> { if (m.getName().equals("onSaved")) savedB[0]++; return null; });
            Object startup = java.lang.reflect.Proxy.newProxyInstance(stC.getClassLoader(), new Class<?>[]{stC}, (pr, m, ar) -> { if (m.getName().equals("run")) starts[0]++; return null; });
            rc.getMethod("attach", uiC).invoke(rx, uiA);
            rc.getMethod("start", stC).invoke(rx, startup);
            for (int i = 0; i < 50 && !(Boolean) rc.getMethod("running").invoke(rx); i++) Thread.sleep(100);
            try {
                ok((Boolean) rc.getMethod("running").invoke(rx) && "Receiver ready".equals(rc.getMethod("state").invoke(rx)), "#12 first Activity: receiver started: " + rc.getMethod("state").invoke(rx));
                ok(httpSend(port, "1795100000000", m20).startsWith("HTTP/1.1 200") && savedA[0] == 1, "#12 memo 1 over HTTP saved, Activity A told");
                rc.getMethod("detach", uiC).invoke(rx, uiA); // MainActivity.onDestroy
                String r2 = httpSend(port, "1795100060000", m20);
                ok(r2.startsWith("HTTP/1.1 200") && r2.contains("\"dup\":false") && savedA[0] == 1, "#12 Activity destroyed: receiver still answers, memo 2 saved with no Activity: " + r2.substring(r2.indexOf('{')));
                int n = 0; for (String day : lib.days()) n += lib.day(day).entries.size();
                ok(n == 2, "#12 both memos are in the library: " + n);
                rc.getMethod("attach", uiC).invoke(rx, uiB); // a new MainActivity
                rc.getMethod("start", stC).invoke(rx, startup);
                Thread.sleep(300);
                ok(starts[0] == 1 && "Receiver ready".equals(rc.getMethod("state").invoke(rx)), "#12 re-created Activity: startup (import/heal) not run again, no second server, state still ready");
                rc.getMethod("detach", uiC).invoke(rx, uiA); // late onDestroy of the old Activity must not detach the new one
                ok(httpSend(port, "1795100120000", m20).startsWith("HTTP/1.1 200") && savedB[0] == 1 && savedA[0] == 1, "#12 memo 3 reaches the new Activity B; the old one's late onDestroy did not detach B");
                ok((Integer) rc.getMethod("sessionCount").invoke(rx) == 3, "#12 'received now' counts all 3 across Activities");
                ok(httpSend(port, "1795100000000", m20).contains("\"dup\":true") && (Integer) rc.getMethod("sessionCount").invoke(rx) == 3, "#12 resend is a duplicate and not counted");
            } finally { rc.getMethod("stop").invoke(rx); }
        });

        System.out.println("FIXTESTS: " + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }

    static String httpSend(int port, String id, byte[] raw) throws IOException {
        String b64 = Base64.getEncoder().encodeToString(raw);
        String c = raw(port, "POST /chunk?id=" + id + "&i=0&n=1&o=0 HTTP/1.1\r\nContent-Length: " + b64.length() + "\r\n\r\n" + b64);
        if (!c.startsWith("HTTP/1.1 200")) return c;
        CRC32 k = new CRC32(); k.update(raw);
        String f = "id=" + id + "&t=" + id + "&size=" + raw.length + "&crc=" + k.getValue() + "&tz=60&fix=0&mode=o&recMs=1000&stopKey=SELECT";
        return raw(port, "POST /commit HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: " + f.length() + "\r\n\r\n" + f);
    }
    static String raw(int port, String req) throws IOException {
        try (Socket k = new Socket("127.0.0.1", port)) {
            k.setSoTimeout(3000);
            k.getOutputStream().write(req.getBytes(StandardCharsets.US_ASCII)); k.getOutputStream().flush();
            ByteArrayOutputStream o = new ByteArrayOutputStream(); byte[] b = new byte[4096]; int n;
            try { while ((n = k.getInputStream().read(b)) > 0) o.write(b, 0, n); } catch (SocketTimeoutException ignored) {}
            return o.toString("US-ASCII");
        }
    }
    static List<File> listOgg(File d) {
        List<File> out = new ArrayList<>(); File[] fs = d.listFiles(); if (fs == null) return out;
        Arrays.sort(fs);
        for (File f : fs) { if (f.isDirectory()) out.addAll(listOgg(f)); else if (f.getName().endsWith(".ogg")) out.add(f); }
        return out;
    }
    // ---- Ogg helpers: page offsets, and edits that keep every page CRC valid
    static int[] pages(byte[] b) {
        List<Integer> p = new ArrayList<>();
        for (int off = 0; off < b.length; ) { p.add(off); int ns = b[off + 26] & 0xff, body = 0; for (int i = 0; i < ns; i++) body += b[off + 27 + i] & 0xff; off += 27 + ns + body; }
        int[] r = new int[p.size()]; for (int i = 0; i < r.length; i++) r[i] = p.get(i); return r;
    }
    static byte[] mut(byte[] b, int at, int v) { byte[] c = b.clone(); c[at] = (byte) v; return recrc(c); }
    static byte[] mutLe32(byte[] b, int at, int v) { byte[] c = b.clone(); for (int i = 0; i < 4; i++) c[at + i] = (byte) (v >>> (8 * i)); return recrc(c); }
    static byte[] drop(byte[] b, int from, int to) { byte[] c = new byte[b.length - (to - from)]; System.arraycopy(b, 0, c, 0, from); System.arraycopy(b, to, c, from, b.length - to); return c; }
    static byte[] recrc(byte[] b) {
        for (int off : pages(b)) {
            int ns = b[off + 26] & 0xff, body = 0; for (int i = 0; i < ns; i++) body += b[off + 27 + i] & 0xff;
            int len = 27 + ns + body; for (int i = 22; i < 26; i++) b[off + i] = 0;
            int c = 0; for (int i = off; i < off + len; i++) c = (c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 0xff];
            for (int i = 0; i < 4; i++) b[off + 22 + i] = (byte) (c >>> (8 * i));
        }
        return b;
    }
    static final int[] CRC = new int[256];
    static { for (int i = 0; i < 256; i++) { int r = i << 24; for (int k = 0; k < 8; k++) r = (r & 0x80000000) != 0 ? (r << 1) ^ 0x04C11DB7 : r << 1; CRC[i] = r; } }
}
