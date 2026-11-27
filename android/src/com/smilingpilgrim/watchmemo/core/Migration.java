package com.smilingpilgrim.watchmemo.core;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.*;

/**
 * One-time import of the 0.1.x layout (Documents/WatchMemos/YYYY-MM-DD/HHMMSS.ogg,
 * raw/HHMMSS.zeppopus, day.md, watch-log-*.txt) into the private library + one zip per day.
 *
 * Rules: a day's old folder is only removed after every file in it was imported,
 * the new zip was re-read and matches, and the shared copy of the zip is in place.
 * If anything in a day fails, NOTHING in that day's folder is deleted, and a note is shown.
 * Safe to run on every launch: already-imported files are recognised and not imported twice.
 */
public final class Migration {
    public static final class Result {
        public int daysSeen, daysDone, memosImported;
        public final List<String> notes = new ArrayList<>();
    }

    private final Library lib;
    private final SharedFolder sh;
    private final TimeZone tz;
    private final Library.Log log;
    private final File mapFile;

    public Migration(Library lib, TimeZone tz, Library.Log log) {
        this.lib = lib; this.sh = lib.shared(); this.tz = tz; this.log = log == null ? s -> {} : log;
        this.mapFile = new File(lib.root, "migrated.tsv");
    }

    public Result run() {
        Result r = new Result();
        List<String> days;
        try { days = sh.oldDays(); } catch (Exception e) { r.notes.add("Could not look for 0.1.x folders: " + e.getMessage()); return r; }
        for (String day : days) {
            r.daysSeen++;
            try { importDay(day, r); }
            catch (Exception e) {
                String n = day + ": import stopped (" + e.getMessage() + "). The old folder " + day + "/ was left untouched.";
                r.notes.add(n);
            }
        }
        for (String n : r.notes) { lib.note(n); log.log(n); }
        return r;
    }

    private void importDay(String day, Result r) throws IOException {
        List<SharedFolder.OldFile> files = sh.listOld(day);
        if (files.isEmpty()) { sh.removeOldDirIfEmpty(day); return; }
        Map<String, SharedFolder.OldFile> oggs = new LinkedHashMap<>(), raws = new LinkedHashMap<>(), logs = new LinkedHashMap<>();
        List<SharedFolder.OldFile> superseded = new ArrayList<>(), others = new ArrayList<>(), done = new ArrayList<>();
        for (SharedFolder.OldFile f : files) {
            if (f.sub.equals("raw") && f.name.endsWith(".zeppopus")) raws.put(f.name, f);
            else if (f.sub.isEmpty() && f.name.endsWith(".ogg")) oggs.put(f.name, f);
            else if (f.sub.isEmpty() && f.name.startsWith("watch-log-") && f.name.endsWith(".txt")) logs.put(f.name, f);
            else if (f.sub.isEmpty() && f.name.equals("day.md")) superseded.add(f);
            else others.add(f);
        }
        Map<String, String> map = loadMap(day);         // old path -> new name, from earlier runs
        DayLog dl = lib.day(day);
        List<String> problems = new ArrayList<>(), lost = new ArrayList<>();
        Map<String, Long> wantInZip = new HashMap<>();   // new name -> CRC of the bytes we keep
        int imported = 0;

        // 1. memos the app already knows about (0.1.x kept its table in private storage too)
        for (Entry e : dl.entries) {
            if (!e.file.endsWith(".ogg")) continue;
            File have = lib.audio(day, e.file);
            if (have.isFile() && !oggs.containsKey(e.file)) {           // already new-style (imported before, or 0.2 memo)
                wantInZip.put(e.file, Library.crc(Files.readAllBytes(have.toPath())));
                continue;
            }
            String oldName = e.file;
            SharedFolder.OldFile of = oggs.remove(oldName);
            SharedFolder.OldFile rf = raws.remove(e.raw.isEmpty() ? base(oldName) + ".zeppopus" : e.raw);
            byte[] audio = null; String why = null;
            if (of != null) {
                byte[] b = sh.readOld(of);
                try { OggCheck.check(b); audio = b; } catch (IllegalArgumentException ex) { why = oldName + " is damaged (" + ex.getMessage() + ")"; }
            }
            if (audio == null && rf != null) {
                byte[] b = sh.readOld(rf);
                if (b.length != e.size || Library.crc(b) != e.crc) why = (why == null ? "" : why + "; ") + rf.name + " does not match what the watch sent";
                else {
                    try { audio = repack(b, e.id, day + " " + e.time); }
                    catch (Exception ex) { why = (why == null ? "" : why + "; ") + rf.name + " could not be converted (" + ex.getMessage() + ")"; }
                }
            }
            if (audio == null) {
                if (of == null && rf == null) { lost.add(oldName); e.note = add(e.note, "audio file was missing when 0.2.0 imported this day"); e.file = "(missing)"; continue; }
                problems.add(why);
                continue;
            }
            String nn = newName(e.time, oldName, dl, day);
            Library.writeAtomic(lib.audio(day, nn), audio);
            check(lib.audio(day, nn), audio);
            wantInZip.put(nn, Library.crc(audio));
            e.file = nn; e.raw = "";
            if (e.audioMs < 0) e.audioMs = OggCheck.check(audio).durationMs();
            if (of != null) { done.add(of); remember(day, of.path(), nn); }
            if (rf != null) done.add(rf);
            imported++;
        }

        // 2. .ogg files the table doesn't know (e.g. app data was cleared): details from the old day.md if possible
        Map<String, String[]> rows = new HashMap<>();
        for (SharedFolder.OldFile f : superseded) rows = parseDayMd(new String(sh.readOld(f), StandardCharsets.UTF_8));
        for (SharedFolder.OldFile of : new ArrayList<>(oggs.values())) {
            oggs.remove(of.name);
            SharedFolder.OldFile rf = raws.remove(base(of.name) + ".zeppopus");
            String prev = map.get(of.path());
            if (prev != null && lib.audio(day, prev).isFile()) {          // imported on an earlier run, folder kept then
                byte[] b = sh.readOld(of);
                if (Library.crc(b) == Library.crc(Files.readAllBytes(lib.audio(day, prev).toPath()))) {
                    done.add(of); if (rf != null) done.add(rf); continue;
                }
            }
            byte[] b = sh.readOld(of);
            byte[] audio = null; String why = null;
            try { OggCheck.check(b); audio = b; } catch (IllegalArgumentException ex) { why = of.name + " is damaged (" + ex.getMessage() + ")"; }
            if (audio == null && rf != null) {
                try { audio = repack(sh.readOld(rf), "0", day); } catch (Exception ex) { why += "; raw copy could not be converted either"; }
            }
            if (audio == null) { problems.add(why); continue; }
            Entry e = orphan(day, of.name, rows.get(of.name), audio);
            String nn = newName(e.time, of.name, dl, day);
            Library.writeAtomic(lib.audio(day, nn), audio);
            check(lib.audio(day, nn), audio);
            e.file = nn;
            dl.entries.add(e);
            wantInZip.put(nn, Library.crc(audio));
            done.add(of); if (rf != null) done.add(rf);
            remember(day, of.path(), nn);
            imported++;
        }
        // 3. raw files with no .ogg at all
        for (SharedFolder.OldFile rf : new ArrayList<>(raws.values())) {
            String prev = map.get(rf.path());
            if (prev != null && lib.audio(day, prev).isFile()) { done.add(rf); continue; }
            try {
                byte[] audio = repack(sh.readOld(rf), "0", day);
                Entry e = orphan(day, base(rf.name) + ".ogg", rows.get(base(rf.name) + ".ogg"), audio);
                String nn = newName(e.time, rf.name, dl, day);
                Library.writeAtomic(lib.audio(day, nn), audio);
                check(lib.audio(day, nn), audio);
                e.file = nn; dl.entries.add(e);
                wantInZip.put(nn, Library.crc(audio));
                done.add(rf); remember(day, rf.path(), nn); imported++;
            } catch (Exception ex) { problems.add("raw/" + rf.name + " could not be converted (" + ex.getMessage() + ")"); }
        }
        // 4. watch logs, byte for byte
        for (SharedFolder.OldFile lf : logs.values()) {
            byte[] b = sh.readOld(lf);
            File dst = lib.audio(day, lf.name);
            if (dst.isFile() && Library.crc(Files.readAllBytes(dst.toPath())) != Library.crc(b)) dst = lib.audio(day, base(lf.name) + "-old.txt");
            Library.writeAtomic(dst, b);
            check(dst, b);
            wantInZip.put(dst.getName(), Library.crc(b));
            done.add(lf);
        }
        for (SharedFolder.OldFile o : others) problems.add(o.path() + " is not a memo file, left where it is");

        dl.save();
        File zip = lib.rebuild(day);
        Map<String, Long> inZip = DayZip.read(zip);
        for (Map.Entry<String, Long> w : wantInZip.entrySet())
            if (!w.getValue().equals(inZip.get(w.getKey()))) throw new IOException("zip check failed for " + w.getKey());
        if (sh.size(Library.zipName(day)) != zip.length()) throw new IOException("the zip could not be saved to " + sh.describe());
        r.memosImported += imported;

        if (!problems.isEmpty()) {
            r.notes.add(day + ": " + imported + " memo(s) imported into " + Library.zipName(day) + ", but the old folder " + day
                    + "/ was left untouched because: " + String.join("; ", problems));
            return;
        }
        // Everything verified: remove what was imported (and the old day.md, which the zip replaces).
        int deleted = 0;
        List<SharedFolder.OldFile> del = new ArrayList<>(done); del.addAll(superseded);
        for (SharedFolder.OldFile f : del) if (sh.deleteOld(f)) deleted++;
        sh.removeOldDirIfEmpty(day);
        r.daysDone++;
        String msg = day + ": imported " + imported + " memo(s) from the old folder into " + Library.zipName(day) + ", removed " + deleted + " old file(s)";
        if (!lost.isEmpty()) r.notes.add(day + ": " + lost.size() + " memo(s) were already missing from the old folder: " + String.join(", ", lost));
        log.log(msg);
    }

    // ---- helpers ----
    private static byte[] repack(byte[] raw, String id, String title) throws IOException {
        ZeppOpus.Parsed p = ZeppOpus.parse(raw);
        if (p.packets.isEmpty()) throw new IOException("no Opus packets");
        long serial = 1; try { serial = Long.parseLong(id); } catch (Exception ignored) {}
        byte[] ogg = OggOpus.build(p.packets, 16000, (int) (serial & 0x7fffffff), title);
        OggCheck.Info i = OggCheck.check(ogg);
        if (i.audioPackets != p.packets.size()) throw new IOException("packet count changed");
        return ogg;
    }

    private static void check(File f, byte[] want) throws IOException {
        byte[] b = Files.readAllBytes(f.toPath());
        if (b.length != want.length || Library.crc(b) != Library.crc(want)) throw new IOException(f.getName() + " reads back different");
    }

    private String newName(String time, String oldName, DayLog dl, String day) {
        String hms = time != null && time.matches("\\d\\d:\\d\\d:\\d\\d") ? time.substring(0, 2) + time.substring(3, 5) + "-" + time.substring(6, 8)
                : base(oldName).replaceAll("[^0-9A-Za-z-]", "");
        if (hms.matches("\\d{6}(-\\d+)?")) hms = hms.substring(0, 4) + "-" + hms.substring(4);
        String n = hms + ".ogg";
        for (int k = 2; dl.nameTaken(n) || lib.audio(day, n).exists(); k++) n = hms + "-" + k + ".ogg";
        return n;
    }

    private Entry orphan(String day, String oldName, String[] row, byte[] ogg) {
        Entry e = new Entry();
        String b = base(oldName);
        e.time = b.matches("\\d{6}.*") ? b.substring(0, 2) + ":" + b.substring(2, 4) + ":" + b.substring(4, 6) : "00:00:00";
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT); f.setTimeZone(tz);
            e.t = f.parse(day + " " + e.time).getTime();
        } catch (Exception ex) { e.t = 0; }
        e.id = "old-" + day + "-" + b;
        e.size = ogg.length; e.crc = Library.crc(ogg);
        e.audioMs = OggCheck.check(ogg).durationMs();
        e.note = "imported from 0.1.x";
        if (row != null) {
            String ll = row[1];
            if (ll.matches("-?\\d+(\\.\\d+)?, *-?\\d+(\\.\\d+)?")) {
                String[] p = ll.split(",");
                e.lat = Double.parseDouble(p[0].trim()); e.lon = Double.parseDouble(p[1].trim()); e.fix = true;
            }
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\d+) sats").matcher(row[2]);
            if (m.find()) e.sats = Integer.parseInt(m.group(1));
            m = java.util.regex.Pattern.compile("([0-9.]+) s").matcher(row[3]);
            if (m.find()) e.fixS = Double.parseDouble(m.group(1));
        } else e.note += " without details (no day.md row)";
        return e;
    }

    /** First table of a 0.1.x day.md: | Time | Lat, Lon | Accuracy | GPS fix | Length | Map | File | -> file -> cells */
    static Map<String, String[]> parseDayMd(String md) {
        Map<String, String[]> rows = new HashMap<>();
        boolean inFirst = false;
        for (String line : md.split("\n")) {
            if (line.startsWith("| Time ")) { inFirst = true; continue; }
            if (inFirst && !line.startsWith("|")) { if (!rows.isEmpty()) break; continue; }
            if (!inFirst || line.startsWith("|---")) continue;
            String[] c = line.split("\\|", -1);
            if (c.length < 9) continue;
            String[] cells = new String[7];
            for (int i = 0; i < 7; i++) cells[i] = c[i + 1].trim();
            rows.put(cells[6], cells);
        }
        return rows;
    }

    private Map<String, String> loadMap(String day) {
        Map<String, String> m = new HashMap<>();
        if (!mapFile.isFile()) return m;
        try {
            for (String l : Files.readAllLines(mapFile.toPath(), StandardCharsets.UTF_8)) {
                String[] p = l.split("\t");
                if (p.length == 3 && p[0].equals(day)) m.put(p[1], p[2]);
            }
        } catch (IOException ignored) {}
        return m;
    }

    private void remember(String day, String oldPath, String newName) {
        try (Writer w = new OutputStreamWriter(new FileOutputStream(mapFile, true), StandardCharsets.UTF_8)) {
            w.write(day + "\t" + oldPath + "\t" + newName + "\n");
        } catch (IOException ignored) {}
    }

    private static String base(String n) { int i = n.lastIndexOf('.'); return i > 0 ? n.substring(0, i) : n; }
    private static String add(String a, String b) { return a == null || a.isEmpty() ? b : a + "; " + b; }
}
