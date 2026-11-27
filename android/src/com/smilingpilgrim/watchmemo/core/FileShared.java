package com.smilingpilgrim.watchmemo.core;

import java.io.*;
import java.nio.file.*;
import java.util.*;

/** SharedFolder on a plain directory: Android 8/9 (public Documents) and the box tests. */
public final class FileShared implements SharedFolder {
    private final File dir;
    public FileShared(File watchMemosDir) { dir = watchMemosDir; }

    @Override public String describe() { return dir.getPath(); }

    @Override public void publish(String name, File src) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File tmp = new File(dir, "." + name + ".part");
        try (InputStream in = new FileInputStream(src); FileOutputStream out = new FileOutputStream(tmp)) {
            Library.copy(in, out);
            out.getFD().sync();
        }
        try {
            Files.move(tmp.toPath(), new File(dir, name).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            tmp.delete();
            throw e;
        }
    }

    @Override public long size(String name) {
        File f = new File(dir, name);
        return f.isFile() ? f.length() : -1;
    }

    @Override public List<String> oldDays() {
        List<String> out = new ArrayList<>();
        File[] fs = dir.listFiles();
        if (fs != null) for (File f : fs) if (f.isDirectory() && Library.isDay(f.getName())) out.add(f.getName());
        Collections.sort(out);
        return out;
    }

    @Override public List<OldFile> listOld(String day) {
        List<OldFile> out = new ArrayList<>();
        add(out, day, "", new File(dir, day));
        add(out, day, "raw", new File(dir, day + "/raw"));
        return out;
    }

    private static void add(List<OldFile> out, String day, String sub, File d) {
        File[] fs = d.listFiles();
        if (fs == null) return;
        Arrays.sort(fs);
        for (File f : fs) if (f.isFile()) out.add(new OldFile(day, sub, f.getName(), f.length(), f));
    }

    @Override public byte[] readOld(OldFile f) throws IOException { return Files.readAllBytes(((File) f.handle).toPath()); }
    @Override public boolean deleteOld(OldFile f) { return ((File) f.handle).delete(); }

    @Override public void removeOldDirIfEmpty(String day) {
        new File(dir, day + "/raw").delete(); // only succeeds when empty
        new File(dir, day).delete();
    }
}
