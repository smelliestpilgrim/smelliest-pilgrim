package com.smilingpilgrim.watchmemo.core;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** The memos of one day, kept in app storage and rendered to day.md. */
public final class DayLog {
    public final String day;
    public final List<Entry> entries = new ArrayList<>();
    private final File file;

    public DayLog(File dir, String day) {
        this.day = day;
        this.file = new File(dir, day + ".tsv");
        if (file.exists()) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    Entry e = Entry.fromLine(line);
                    if (e != null) entries.add(e);
                }
            } catch (IOException ignored) {}
        }
    }

    public Entry find(String id) {
        for (Entry e : entries) if (e.id.equals(id)) return e;
        return null;
    }

    public boolean nameTaken(String name) {
        for (Entry e : entries) if (e.file.equals(name)) return true;
        return false;
    }

    public void add(Entry e) throws IOException {
        entries.add(e);
        save();
    }

    /** Rewrites the .tsv atomically (temp file, then rename). */
    public void save() throws IOException {
        entries.sort(Comparator.comparingLong(a -> a.t));
        file.getParentFile().mkdirs();
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream fo = new FileOutputStream(tmp); Writer w = new OutputStreamWriter(fo, StandardCharsets.UTF_8)) {
            for (Entry x : entries) w.write(x.toLine() + "\n");
            w.flush();
            fo.getFD().sync();
        }
        java.nio.file.Files.move(tmp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }

    /** Total audio length of the day. */
    public long totalMs() { long t = 0; for (Entry e : entries) if (e.audioMs > 0) t += e.audioMs; return t; }
    public Entry firstFix() { for (Entry e : entries) if (e.fix) return e; return null; }
    public Entry lastFix() { for (int i = entries.size() - 1; i >= 0; i--) if (entries.get(i).fix) return entries.get(i); return null; }

    public String markdown() { return markdown(java.util.Collections.<File>emptyList()); }

    public String markdown(List<File> logs) {
        StringBuilder sb = new StringBuilder();
        sb.append("# Watch memos ").append(day).append("\n\n");
        sb.append(entries.size()).append(entries.size() == 1 ? " memo" : " memos")
          .append(". Times are the watch's local time at the start of each memo.\n\n");
        // Satellites only when the watch sent them (Send page "GPS+sats");
        // otherwise no column at all rather than a column of n/a.
        boolean sats = false;
        for (Entry e : entries) if (e.fix && e.sats > 0) sats = true;
        sb.append(sats ? "| Time | Lat, Lon | GPS fix took | Sats | Length | Google Maps | File |\n"
                       : "| Time | Lat, Lon | GPS fix took | Length | Google Maps | File |\n");
        sb.append(sats ? "|---|---|---|---|---|---|---|\n" : "|---|---|---|---|---|---|\n");
        for (Entry e : entries) {
            String fix = e.fix ? (e.fixS >= 0 ? trim(e.fixS) + " s" : "yes") : "no fix";
            String map = e.fix ? "[open](" + e.mapUrl() + ")" : "";
            sb.append("| ").append(e.time).append(" | ").append(e.latLon()).append(" | ").append(fix);
            if (sats) sb.append(" | ").append(e.fix && e.sats > 0 ? String.valueOf(e.sats) : "");
            sb.append(" | ").append(Entry.dur(e.audioMs)).append(" | ").append(map)
              .append(" | ").append(e.file).append(" |\n");
        }
        if (!logs.isEmpty()) {
            sb.append("\nWatch log").append(logs.size() == 1 ? ": " : "s: ");
            for (int i = 0; i < logs.size(); i++) sb.append(i > 0 ? ", " : "").append(logs.get(i).getName());
            sb.append("\n");
        }
        sb.append("\n## Test details\n\n");
        sb.append("| File | Wall time | Audio | Survived | Max tick gap | Stop | GPS wait after stop | Bytes | Note |\n");
        sb.append("|---|---|---|---|---|---|---|---|---|\n");
        for (Entry e : entries) {
            sb.append("| ").append(e.file).append(" | ").append(Entry.dur(e.recMs)).append(" | ").append(Entry.dur(e.audioMs))
              .append(" | ").append(e.survived()).append(" | ").append(e.maxGapMs >= 0 ? e.maxGapMs + " ms" : "?")
              .append(" | ").append(e.stopKey.isEmpty() ? "?" : e.stopKey)
              .append(" | ").append(e.gpsWaitS >= 0 ? e.gpsWaitS + " s" : "?")
              .append(" | ").append(e.size).append(" | ")
              .append(e.note).append(e.truncated ? " (file ended mid-packet)" : "")
              .append(e.keepOn ? "" : " [screen-on OFF]").append(" |\n");
        }
        return sb.toString();
    }

    static String trim(double d) {
        return d == Math.rint(d) ? String.valueOf((long) d) : String.valueOf(Math.round(d * 10) / 10.0);
    }
}
