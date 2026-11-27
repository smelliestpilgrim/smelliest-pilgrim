import com.smilingpilgrim.watchmemo.core.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

public class TestMain {
    static int pass = 0, fail = 0;
    static void ok(boolean c, String m) { if (c) { pass++; System.out.println("  ok " + m); } else { fail++; System.out.println("  FAIL " + m); } }
    static final TimeZone MADRID = TimeZone.getTimeZone("Europe/Madrid");

    static Library lib(File state, File docs, List<String> logs) {
        return new Library(state, new FileShared(new File(docs, "WatchMemos")), s -> { logs.add(s); System.out.println("    log: " + s); });
    }

    public static void main(String[] a) throws Exception {
        switch (a[0]) {
            case "convert": {
                byte[] raw = Files.readAllBytes(Paths.get(a[1]));
                ZeppOpus.Parsed p = ZeppOpus.parse(raw);
                byte[] ogg = OggOpus.build(p.packets, 16000, 1234, "test");
                OggCheck.check(ogg);
                Files.write(Paths.get(a[2]), ogg);
                System.out.println("packets=" + p.packets.size() + " durationMs=" + p.durationMs() + " truncated=" + p.truncated());
                break;
            }
            case "ogg": { // test fixture: <zeppopus> <out.ogg> <serial> <title>, exactly as the phone app writes it
                ZeppOpus.Parsed p = ZeppOpus.parse(Files.readAllBytes(Paths.get(a[1])));
                Files.write(Paths.get(a[2]), OggOpus.build(p.packets, 16000, Integer.parseInt(a[3]), a[4]));
                break;
            }
            case "serve": {
                Library lib = lib(new File(a[2]), new File(a[1]), new ArrayList<>());
                MemoService svc = new MemoService(lib, MADRID, new MemoService.Listener() {
                    public void onSaved(Entry e, int today, boolean dup) { System.out.println("SAVED " + e.file + " today=" + today + " dup=" + dup); }
                    public void onLog(String s) { System.out.println("LOG " + s); }
                });
                Http h = new Http(svc, Integer.parseInt(a[3]));
                h.start();
                System.out.println("LISTENING");
                System.out.flush();
                while (System.in.read() >= 0) {}
                h.stop();
                break;
            }
            case "unit": unit(new File(a[1]), new File(a[2])); break;
            case "stress": stress(new File(a[1]), new File(a[2])); break;
            default: throw new IllegalArgumentException(a[0]);
        }
    }

    static Map<String, String> form(String id, long t, byte[] raw, boolean fix) {
        Map<String, String> f = new LinkedHashMap<>();
        java.util.zip.CRC32 c = new java.util.zip.CRC32(); c.update(raw);
        f.put("id", id); f.put("t", String.valueOf(t)); f.put("size", String.valueOf(raw.length)); f.put("crc", String.valueOf(c.getValue()));
        f.put("tz", "60"); f.put("fix", fix ? "1" : "0"); f.put("lat", "43.009312"); f.put("lon", "-1.319522"); f.put("sats", "9"); f.put("fixS", "41");
        f.put("recMs", "12500"); f.put("keepOn", "1"); f.put("stopKey", "SELECT");
        return f;
    }

    static MemoService.Reply send(MemoService s, String id, long t, byte[] raw, boolean fix) {
        int n = (raw.length + 2047) / 2048;
        for (int i = 0; i < n; i++) {
            byte[] part = Arrays.copyOfRange(raw, i * 2048, Math.min(raw.length, (i + 1) * 2048));
            Map<String, String> q = new HashMap<>(); q.put("id", id); q.put("i", "" + i); q.put("n", "" + n);
            MemoService.Reply r = s.handle("POST", "/chunk", q, Base64.getEncoder().encode(part));
            if (r.status != 200) return r;
        }
        StringBuilder b = new StringBuilder();
        for (Map.Entry<String, String> e : form(id, t, raw, fix).entrySet()) b.append(b.length() > 0 ? "&" : "").append(e.getKey()).append('=').append(e.getValue());
        return s.handle("POST", "/commit", new HashMap<>(), b.toString().getBytes(StandardCharsets.UTF_8));
    }

    static List<String> zipNames(File z) throws IOException {
        List<String> n = new ArrayList<>();
        try (ZipFile zf = new ZipFile(z)) { for (Enumeration<? extends ZipEntry> e = zf.entries(); e.hasMoreElements();) n.add(e.nextElement().getName()); }
        return n;
    }
    static byte[] zipEntry(File z, String name) throws IOException {
        try (ZipFile zf = new ZipFile(z); InputStream in = zf.getInputStream(zf.getEntry(name))) {
            ByteArrayOutputStream o = new ByteArrayOutputStream(); Library.copy(in, o); return o.toByteArray();
        }
    }
    static List<String> list(File d) {
        List<String> out = new ArrayList<>();
        if (d.isDirectory()) try { Files.walk(d.toPath()).filter(Files::isRegularFile).forEach(p -> out.add(d.toPath().relativize(p).toString())); } catch (IOException ignored) {}
        Collections.sort(out);
        return out;
    }

    static void unit(File data, File work) throws Exception {
        byte[] m20 = Files.readAllBytes(new File(data, "m20.zeppopus").toPath());
        byte[] m60 = Files.readAllBytes(new File(data, "m60.zeppopus").toPath());
        byte[] lng = Files.readAllBytes(new File(data, "long.zeppopus").toPath());
        long t1 = 1794663125000L; // 2026-11-14 14:32:05 Madrid
        String day = "2026-11-14";

        System.out.println("-- receive: one zip per day, private working copies, raw dropped after verification");
        File docs = new File(work, "docs"), state = new File(work, "state");
        List<String> logs = new ArrayList<>();
        Library lib = lib(state, docs, logs);
        MemoService svc = new MemoService(lib, MADRID, null);
        MemoService.Reply r = send(svc, "" + t1, t1, m20, true);
        ok(r.status == 200 && r.json.contains("\"file\":\"1432-05.ogg\""), "first memo saved as 1432-05.ogg: " + r.json);
        File shared = new File(docs, "WatchMemos/WatchMemos_" + day + ".zip");
        ok(list(new File(docs, "WatchMemos")).equals(Arrays.asList("WatchMemos_" + day + ".zip")), "shared folder holds only the day zip: " + list(new File(docs, "WatchMemos")));
        ok(zipNames(shared).equals(Arrays.asList("1432-05.ogg", "day.md")), "zip = 1432-05.ogg + day.md: " + zipNames(shared));
        ok(!lib.rawFile("" + t1).exists() && list(lib.rawDir).isEmpty(), "private raw copy deleted after the .ogg was verified");
        ok(lib.audio(day, "1432-05.ogg").isFile(), "working copy lives in private storage (files/memos/" + day + "/)");
        byte[] ogg1 = zipEntry(shared, "1432-05.ogg");
        ok(OggCheck.check(ogg1).audioPackets == ZeppOpus.parse(m20).packets.size(), "the zipped .ogg passes the Ogg check (all packets)");

        r = send(svc, "" + (t1 + 3_600_000), t1 + 3_600_000, m60, false);
        r = send(svc, "" + (t1 + 60_000), t1 + 60_000, lng, true);
        Map<String, String> q = new HashMap<>(); q.put("id", "77"); q.put("i", "0"); q.put("n", "1");
        // log for "today" in the default zone: only check it lands in *some* zip
        svc.handle("POST", "/logpart", q, Base64.getEncoder().encode("12:00:00 launch v0.1.2\n".getBytes(StandardCharsets.UTF_8)));
        List<String> names = zipNames(shared);
        ok(names.subList(0, 4).equals(Arrays.asList("1432-05.ogg", "1433-05.ogg", "1532-05.ogg", "day.md")), "zip rebuilt on each memo, time order: " + names);
        String md = new String(zipEntry(shared, "day.md"), StandardCharsets.UTF_8);
        ok(md.contains("| 14:32:05 | 43.009312, -1.319522 | 41 s | 9 | 0:12 | [open](https://maps.google.com/?q=43.009312,-1.319522) | 1432-05.ogg |"),
                "day.md row has time, lat/lon, fix seconds, sats, length, Maps link, filename");
        ok(md.contains("| Time | Lat, Lon | GPS fix took | Sats | Length |") && !md.contains("n/a"), "Sats column present when the watch sent satellites; no n/a anywhere");
        {
            DayLog nd = new DayLog(new File(state, "nosats-test"), "2026-11-14");
            Entry ne = new Entry(); ne.time = "05:47:49"; ne.fix = true; ne.lat = 42.459655; ne.lon = -6.105502; ne.fixS = 6.1; ne.audioMs = 4000; ne.file = "0547-49.ogg";
            nd.entries.add(ne);
            String nmd = nd.markdown();
            ok(nmd.contains("| Time | Lat, Lon | GPS fix took | Length | Google Maps | File |") && !nmd.contains("Sats") && !nmd.contains("n/a") && !nmd.contains("Accuracy")
               && nmd.contains("| 05:47:49 | 42.459655, -6.105502 | 6.1 s | 0:04 |"), "no satellites from the watch: no Sats column, no n/a");
        }
        ok(md.contains("| 15:32:05 | no fix |"), "memo without GPS says no fix");
        String today = MemoService.fmt("yyyy-MM-dd", System.currentTimeMillis(), MADRID);
        File tz = new File(docs, "WatchMemos/WatchMemos_" + today + ".zip");
        ok(tz.isFile() && zipNames(tz).stream().anyMatch(n -> n.startsWith("watch-log-")), "watch log goes into that day's zip: " + (tz.isFile() ? zipNames(tz) : "missing"));
        if (tz.isFile()) ok(new String(zipEntry(tz, "day.md"), StandardCharsets.UTF_8).contains("Watch log: watch-log-"), "day.md names the watch log");

        System.out.println("-- dedupe on resend");
        long before = shared.length();
        r = send(svc, "" + t1, t1, m20, true);
        ok(r.status == 200 && r.json.contains("\"dup\":true") && r.json.contains("1432-05.ogg"), "resend of a saved memo -> dup=true, same name");
        ok(zipNames(shared).stream().filter(n -> n.endsWith(".ogg")).count() == 3 && lib.day(day).entries.size() == 3, "still 3 memos, no 1432-05-2.ogg");
        ok(shared.length() == before, "zip unchanged by the resend");
        byte[] bad = m20.clone(); bad[100] ^= 1;
        Map<String, String> q2 = new HashMap<>(); q2.put("id", "" + t1); q2.put("i", "0"); q2.put("n", "1");
        r = send(svc, "" + t1, t1, bad, true);
        ok(r.status == 409, "same id with different bytes is refused (409)");

        System.out.println("-- atomic rebuild");
        byte[] good = Files.readAllBytes(lib.zip(day).toPath());
        File victim = lib.audio(day, "1433-05.ogg");
        byte[] keep = Files.readAllBytes(victim.toPath());
        victim.setReadable(false, false); // unreadable -> the build fails half way through
        boolean threw = false;
        try { lib.rebuild(day); } catch (IOException e) { threw = true; System.out.println("    (expected) " + e.getMessage()); }
        ok(threw, "a failing rebuild reports the error");
        ok(Arrays.equals(good, Files.readAllBytes(lib.zip(day).toPath())) && Arrays.equals(good, Files.readAllBytes(shared.toPath())), "...and the old private + shared zips are untouched");
        ok(!new File(lib.zipsDir, "WatchMemos_" + day + ".zip.tmp").exists() && list(new File(docs, "WatchMemos")).stream().noneMatch(n -> n.contains(".part")), "no temp files left behind");
        victim.setReadable(true, false);
        shared.delete();
        lib.heal();
        ok(shared.isFile() && Arrays.equals(Files.readAllBytes(shared.toPath()), Files.readAllBytes(lib.zip(day).toPath())), "heal() re-publishes a missing shared zip");

        System.out.println("-- migration from the 0.1.x layout");
        migration(data, new File(work, "mig"), m20, m60, lng);

        System.out.println("UNIT PASS " + pass + (fail > 0 ? " FAIL " + fail : ""));
        if (fail > 0) System.exit(1);
    }

    static byte[] ogg(byte[] raw, String title) { return OggOpus.build(ZeppOpus.parse(raw).packets, 16000, 1, title); }

    static void migration(File data, File w, byte[] m20, byte[] m60, byte[] lng) throws Exception {
        File docs = new File(w, "docs"), state = new File(w, "state"), wm = new File(docs, "WatchMemos");
        // --- what 0.1.1 left behind ---
        String d1 = "2026-11-10", d2 = "2026-11-11", d3 = "2026-11-12";
        File f1 = new File(wm, d1); new File(f1, "raw").mkdirs();
        long t1 = 1794317525000L; // 2026-11-10 14:32:05 Madrid
        Entry e = new Entry();
        e.id = "" + t1; e.t = t1; e.time = "14:32:05"; e.file = "143205.ogg"; e.raw = "143205.zeppopus"; e.size = m20.length; e.crc = Library.crc(m20);
        e.fix = true; e.lat = 42.6; e.lon = -6.8; e.sats = 7; e.fixS = 30; e.audioMs = 12340;
        new File(state, "days").mkdirs();
        Files.write(new File(state, "days/" + d1 + ".tsv").toPath(), (e.toLine() + "\n").getBytes(StandardCharsets.UTF_8));
        Files.write(new File(f1, "143205.ogg").toPath(), ogg(m20, "a"));
        Files.write(new File(f1, "raw/143205.zeppopus").toPath(), m20);
        Files.write(new File(f1, "150000.ogg").toPath(), ogg(m60, "orphan"));       // table lost it; day.md has it
        Files.write(new File(f1, "raw/150000.zeppopus").toPath(), m60);
        Files.write(new File(f1, "raw/160000.zeppopus").toPath(), lng);              // raw only, no .ogg
        Files.write(new File(f1, "watch-log-200000.txt").toPath(), "log line\n".getBytes(StandardCharsets.UTF_8));
        Files.write(new File(f1, "day.md").toPath(), ("# Watch memos " + d1 + "\n\n| Time | Lat, Lon | Accuracy | GPS fix | Length | Map | File |\n|---|---|---|---|---|---|---|\n"
                + "| 14:32:05 | 42.600000, -6.800000 | n/a (7 sats) | 30 s | 0:12 | [map](x) | 143205.ogg |\n"
                + "| 15:00:00 | 42.610000, -6.810000 | n/a (5 sats) | 12 s | 0:08 | [map](x) | 150000.ogg |\n").getBytes(StandardCharsets.UTF_8));
        // day 2: a damaged .ogg with no raw -> must be left completely alone
        File f2 = new File(wm, d2); f2.mkdirs();
        byte[] dmg = ogg(m20, "b"); dmg = Arrays.copyOf(dmg, dmg.length - 40);
        Files.write(new File(f2, "101010.ogg").toPath(), dmg);
        Files.write(new File(f2, "111111.ogg").toPath(), ogg(m60, "fine"));
        // day 3: good memo + a stranger file
        File f3 = new File(wm, d3); f3.mkdirs();
        Files.write(new File(f3, "080000.ogg").toPath(), ogg(m60, "c"));
        Files.write(new File(f3, "photo.jpg").toPath(), new byte[]{1, 2, 3});
        Map<String, byte[]> before2 = snapshot(f2), before3 = snapshot(f3);

        List<String> logs = new ArrayList<>();
        Library lib = lib(state, docs, logs);
        Migration.Result r = new Migration(lib, MADRID, null).run();
        ok(r.daysSeen == 3 && r.daysDone == 1, "3 old day folders seen, 1 fully imported: " + r.daysSeen + "/" + r.daysDone);
        ok(!f1.exists(), d1 + "/ removed after a verified import");
        File z1 = new File(wm, "WatchMemos_" + d1 + ".zip");
        ok(z1.isFile() && zipNames(z1).equals(Arrays.asList("1432-05.ogg", "1500-00.ogg", "1600-00.ogg", "day.md", "watch-log-200000.txt")), "zip has all 3 memos, day.md, log: " + (z1.isFile() ? zipNames(z1) : "none"));
        ok(Arrays.equals(zipEntry(z1, "1432-05.ogg"), ogg(m20, "a")), "imported .ogg is byte-identical to the old one");
        String md = new String(zipEntry(z1, "day.md"), StandardCharsets.UTF_8);
        ok(md.contains("| 15:00:00 | 42.610000, -6.810000 | 12 s | 5 |"), "orphan .ogg got its place back from the old day.md");
        ok(md.contains("| 16:00:00 | no fix |"), "raw-only memo converted and listed");
        ok(snapshot(f2).equals(before2) || sameSnap(snapshot(f2), before2), d2 + "/ (damaged file) untouched, byte for byte");
        ok(sameSnap(snapshot(f3), before3), d3 + "/ (unknown photo.jpg) untouched");
        File z2 = new File(wm, "WatchMemos_" + d2 + ".zip");
        ok(z2.isFile() && zipNames(z2).contains("1111-11.ogg") && !zipNames(z2).contains("1010-10.ogg"), "the good memo of the damaged day is still in its zip: " + (z2.isFile() ? zipNames(z2) : "none"));
        List<String> notes = lib.notes();
        ok(notes.stream().anyMatch(n -> n.startsWith(d2) && n.contains("101010.ogg is damaged") && n.contains("left untouched")), "note explains " + d2);
        ok(notes.stream().anyMatch(n -> n.startsWith(d3) && n.contains("photo.jpg")), "note explains " + d3);
        ok(lib.days().equals(Arrays.asList(d3, d2, d1)), "library lists the imported days newest first: " + lib.days());

        System.out.println("-- migration again (next launch): idempotent");
        int n1 = lib.day(d2).entries.size();
        new Migration(lib, MADRID, null).run();
        ok(lib.day(d2).entries.size() == n1 && zipNames(z2).equals(zipNames(z2)) && zipNames(z2).stream().filter(x -> x.endsWith(".ogg")).count() == 1, "no duplicate memos on a second run: " + zipNames(z2));
        ok(sameSnap(snapshot(f2), before2) && sameSnap(snapshot(f3), before3), "kept folders still untouched");
        // the user removes the stranger photo by hand -> day 3 completes on the next launch
        new File(f3, "photo.jpg").delete();
        new Migration(lib, MADRID, null).run();
        ok(!f3.exists() && zipNames(new File(wm, "WatchMemos_" + d3 + ".zip")).equals(Arrays.asList("0800-00.ogg", "day.md")), d3 + " completes once the stranger file is gone, no duplicate");
    }

    static Map<String, byte[]> snapshot(File d) throws IOException {
        Map<String, byte[]> m = new TreeMap<>();
        for (String n : list(d)) m.put(n, Files.readAllBytes(new File(d, n).toPath()));
        return m;
    }
    static boolean sameSnap(Map<String, byte[]> a, Map<String, byte[]> b) {
        if (!a.keySet().equals(b.keySet())) return false;
        for (String k : a.keySet()) if (!Arrays.equals(a.get(k), b.get(k))) return false;
        return true;
    }

    /** Rebuild the same day in a loop; the shell kill -9s us at random moments. */
    static void stress(File data, File work) throws Exception {
        byte[] lng = Files.readAllBytes(new File(data, "long.zeppopus").toPath());
        Library lib = lib(new File(work, "state"), new File(work, "docs"), new ArrayList<>());
        MemoService svc = new MemoService(lib, MADRID, null);
        long t = 1794663125000L;
        if (lib.day("2026-11-14").entries.size() < 6) for (int i = 0; i < 6; i++) send(svc, "" + (t + i * 60000L), t + i * 60000L, lng, true);
        System.out.println("STRESSING"); System.out.flush();
        while (true) lib.rebuild("2026-11-14");
    }
}
