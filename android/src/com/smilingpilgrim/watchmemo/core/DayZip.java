package com.smilingpilgrim.watchmemo.core;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.zip.*;

/** WatchMemos_YYYY-MM-DD.zip: the day's HHMM-SS.ogg files (time order), day.md, and any watch logs. */
public final class DayZip {
    /** Writes the zip to out; returns name -> CRC-32 of everything it put in. */
    public static Map<String, Long> build(DayLog dl, File memoDir, List<File> logs, File out) throws IOException {
        Map<String, Long> crcs = new LinkedHashMap<>();
        try (FileOutputStream fo = new FileOutputStream(out); ZipOutputStream z = new ZipOutputStream(new BufferedOutputStream(fo))) {
            z.setComment("Watch memos " + dl.day);
            for (Entry e : dl.entries) {
                if (!e.file.endsWith(".ogg")) continue;
                File f = new File(memoDir, e.file);
                if (!f.isFile()) continue;
                byte[] b = Files.readAllBytes(f.toPath());
                // Ogg is already compressed: store it.
                ZipEntry ze = new ZipEntry(e.file);
                ze.setMethod(ZipEntry.STORED);
                ze.setSize(b.length); ze.setCompressedSize(b.length);
                long c = Library.crc(b);
                ze.setCrc(c);
                if (e.t > 0) ze.setTime(e.t);
                z.putNextEntry(ze); z.write(b); z.closeEntry();
                crcs.put(e.file, c);
            }
            byte[] md = dl.markdown(logs).getBytes(StandardCharsets.UTF_8);
            z.putNextEntry(new ZipEntry("day.md")); z.write(md); z.closeEntry();
            crcs.put("day.md", Library.crc(md));
            for (File f : logs) {
                byte[] b = Files.readAllBytes(f.toPath());
                z.putNextEntry(new ZipEntry(f.getName())); z.write(b); z.closeEntry();
                crcs.put(f.getName(), Library.crc(b));
            }
            z.finish();
            z.flush();
            fo.getFD().sync();
        }
        return crcs;
    }

    /** Re-reads the zip: exactly the expected names, every byte decompresses and matches its CRC. */
    public static void verify(File zip, Map<String, Long> expected) throws IOException {
        Map<String, Long> got = read(zip);
        if (!got.equals(expected)) throw new IOException("zip contents differ: got " + got.keySet() + " expected " + expected.keySet());
    }

    /** name -> CRC-32 computed from the decompressed bytes (and checked against the zip's own CRC). */
    public static Map<String, Long> read(File zip) throws IOException {
        Map<String, Long> got = new LinkedHashMap<>();
        try (ZipFile zf = new ZipFile(zip)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            byte[] buf = new byte[64 * 1024];
            while (en.hasMoreElements()) {
                ZipEntry ze = en.nextElement();
                CRC32 c = new CRC32();
                try (InputStream in = zf.getInputStream(ze)) { int n; while ((n = in.read(buf)) > 0) c.update(buf, 0, n); }
                if (ze.getCrc() != -1 && ze.getCrc() != c.getValue()) throw new IOException("CRC mismatch in " + ze.getName());
                if (got.put(ze.getName(), c.getValue()) != null) throw new IOException("duplicate entry " + ze.getName());
            }
        }
        return got;
    }

    private DayZip() {}
}
