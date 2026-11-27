package com.smilingpilgrim.watchmemo.core;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.CRC32;

/**
 * The app's private store (getFilesDir()), the single source of truth:
 *   days/YYYY-MM-DD.tsv        one line per memo (DayLog)
 *   memos/YYYY-MM-DD/HHMM-SS.ogg, watch-log-HHMMSS.txt
 *   raw/<id>.zeppopus          watch bytes, only until the .ogg is verified
 *   zips/WatchMemos_YYYY-MM-DD.zip   the day's zip; a copy is published to Documents/WatchMemos/
 *   notes.txt                  messages for the user (e.g. migration problems)
 */
public final class Library {
    public interface Log { void log(String s); }

    public final File root, daysDir, memosDir, rawDir, zipsDir;
    private final SharedFolder shared;
    private final Log log;

    public Library(File root, SharedFolder shared, Log log) {
        this.root = root; this.shared = shared; this.log = log == null ? s -> {} : log;
        daysDir = new File(root, "days"); memosDir = new File(root, "memos");
        rawDir = new File(root, "raw"); zipsDir = new File(root, "zips");
        for (File d : new File[]{daysDir, memosDir, rawDir, zipsDir}) d.mkdirs();
    }

    public SharedFolder shared() { return shared; }
    public static boolean isDay(String s) { return s != null && s.matches("\\d{4}-\\d{2}-\\d{2}"); }
    public static String zipName(String day) { return "WatchMemos_" + day + ".zip"; }

    public DayLog day(String day) { return new DayLog(daysDir, day); }
    public File memoDir(String day) { return new File(memosDir, day); }
    public File audio(String day, String name) { return new File(memoDir(day), name); }
    public File rawFile(String id) { return new File(rawDir, id + ".zeppopus"); }
    public File zip(String day) { return new File(zipsDir, zipName(day)); }

    /** Days with anything in them, newest first. */
    public List<String> days() {
        TreeSet<String> s = new TreeSet<>(Collections.reverseOrder());
        String[] t = daysDir.list();
        if (t != null) for (String n : t) if (n.endsWith(".tsv") && isDay(n.substring(0, n.length() - 4))) s.add(n.substring(0, n.length() - 4));
        String[] m = memosDir.list();
        if (m != null) for (String n : m) if (isDay(n) && !logs(n).isEmpty()) s.add(n);
        return new ArrayList<>(s);
    }

    public List<File> logs(String day) {
        List<File> out = new ArrayList<>();
        File[] fs = memoDir(day).listFiles();
        if (fs != null) for (File f : fs) if (f.getName().startsWith("watch-log-") && f.getName().endsWith(".txt")) out.add(f);
        out.sort(Comparator.comparing(File::getName));
        return out;
    }

    /** Rebuild the day's zip (atomically, verified) and publish it to the shared folder. Returns the private zip. */
    public synchronized File rebuild(String day) throws IOException {
        DayLog dl = day(day);
        File zip = zip(day);
        File tmp = new File(zipsDir, zipName(day) + ".tmp");
        Map<String, Long> expected;
        try { expected = DayZip.build(dl, memoDir(day), logs(day), tmp); }
        catch (IOException e) { tmp.delete(); throw new IOException("zip not rebuilt, old one kept: " + e.getMessage()); }
        try {
            DayZip.verify(tmp, expected);
        } catch (IOException e) {
            tmp.delete();
            throw new IOException("new zip failed its check, old one kept: " + e.getMessage());
        }
        Files.move(tmp.toPath(), zip.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        publish(day);
        return zip;
    }

    /** Copy the private zip to Documents/WatchMemos/. False (and logged) if that failed; the private zip is still fine. */
    public boolean publish(String day) {
        try {
            shared.publish(zipName(day), zip(day));
            long got = shared.size(zipName(day));
            if (got != zip(day).length()) throw new IOException("shared copy has " + got + " bytes, expected " + zip(day).length());
            return true;
        } catch (Exception e) {
            log.log("could not update " + shared.describe() + "/" + zipName(day) + ": " + e.getMessage() + " (will retry next launch)");
            return false;
        }
    }

    /** On launch: rebuild missing zips, re-publish any whose shared copy is missing or different. */
    public void heal() {
        for (String d : days()) {
            try {
                if (!zip(d).isFile() || zip(d).lastModified() < newestData(d)) { rebuild(d); continue; }
                if (shared.size(zipName(d)) != zip(d).length()) publish(d);
            } catch (Exception e) { log.log("heal " + d + ": " + e.getMessage()); }
        }
    }

    private long newestData(String day) {
        long t = new File(daysDir, day + ".tsv").lastModified();
        File[] fs = memoDir(day).listFiles();
        if (fs != null) for (File f : fs) t = Math.max(t, f.lastModified());
        return t;
    }

    // ---- notes shown to the user ----
    public synchronized void note(String s) {
        try (Writer w = new OutputStreamWriter(new FileOutputStream(new File(root, "notes.txt"), true), StandardCharsets.UTF_8)) {
            w.write(s.replace('\n', ' ') + "\n");
        } catch (IOException ignored) {}
    }
    public synchronized List<String> notes() {
        File f = new File(root, "notes.txt");
        List<String> out = new ArrayList<>();
        if (!f.isFile()) return out;
        try { for (String l : Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) if (!l.trim().isEmpty()) out.add(l); }
        catch (IOException ignored) {}
        return out;
    }
    public synchronized void clearNotes() { new File(root, "notes.txt").delete(); }

    // ---- helpers ----
    /** temp file + fsync + rename: the target is either the old or the new content, never half. */
    public static void writeAtomic(File f, byte[] data) throws IOException {
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File tmp = new File(dir, f.getName() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(data); o.getFD().sync(); }
        Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    public static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    public static long crc(byte[] b) { CRC32 c = new CRC32(); c.update(b, 0, b.length); return c.getValue(); }
}
