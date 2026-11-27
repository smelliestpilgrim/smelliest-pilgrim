package com.smilingpilgrim.watchmemo;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import com.smilingpilgrim.watchmemo.core.Library;
import com.smilingpilgrim.watchmemo.core.Protocol;
import com.smilingpilgrim.watchmemo.core.SharedFolder;
import java.io.*;
import java.util.*;

/**
 * Documents/WatchMemos/ through MediaStore (Android 10+). Only sees files this app created,
 * which is exactly what 0.1.x wrote there.
 * publish(): the new zip is written as a hidden pending item first; only when it is complete
 * is the old one removed and the new one given the real name. A crash in between leaves the old zip
 * or no visible zip (healed on the next launch from the private copy), never a broken one.
 */
final class MediaStoreShared implements SharedFolder {
    static final String REL = Environment.DIRECTORY_DOCUMENTS + "/" + Protocol.ROOT + "/";
    private final ContentResolver cr;
    private final Uri coll = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);

    MediaStoreShared(Context c) { cr = c.getApplicationContext().getContentResolver(); }

    @Override public String describe() { return "Documents/" + Protocol.ROOT; }

    private List<Uri> find(String rel, String name) {
        List<Uri> out = new ArrayList<>();
        try (Cursor c = cr.query(coll, new String[]{MediaStore.MediaColumns._ID},
                MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DISPLAY_NAME + "=?", new String[]{rel, name}, null)) {
            while (c != null && c.moveToNext()) out.add(Uri.withAppendedPath(coll, String.valueOf(c.getLong(0))));
        }
        return out;
    }

    @Override public void publish(String name, File src) throws IOException {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, REL);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri nu = cr.insert(coll, v);
        if (nu == null) throw new IOException("MediaStore refused " + name);
        try (InputStream in = new FileInputStream(src); OutputStream o = cr.openOutputStream(nu, "w")) {
            if (o == null) throw new IOException("no stream");
            Library.copy(in, o);
        } catch (IOException | RuntimeException e) {
            cr.delete(nu, null, null);
            throw new IOException("writing " + name + ": " + e.getMessage());
        }
        long got = statSize(nu);
        if (got != src.length()) { cr.delete(nu, null, null); throw new IOException("short write " + got + "/" + src.length()); }
        for (Uri old : find(REL, name)) if (!old.equals(nu)) cr.delete(old, null, null);
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        done.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        cr.update(nu, done, null, null);
    }

    private long statSize(Uri u) {
        try (ParcelFileDescriptor pfd = cr.openFileDescriptor(u, "r")) { return pfd == null ? -1 : pfd.getStatSize(); }
        catch (Exception e) { return -1; }
    }

    @Override public long size(String name) {
        List<Uri> u = find(REL, name);
        return u.isEmpty() ? -1 : statSize(u.get(0));
    }

    @Override public List<String> oldDays() {
        TreeSet<String> days = new TreeSet<>();
        try (Cursor c = cr.query(coll, new String[]{MediaStore.MediaColumns.RELATIVE_PATH},
                MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?", new String[]{REL + "%/%"}, null)) {
            while (c != null && c.moveToNext()) {
                String rest = c.getString(0).substring(REL.length());
                String d = rest.split("/")[0];
                if (Library.isDay(d)) days.add(d);
            }
        }
        return new ArrayList<>(days);
    }

    @Override public List<OldFile> listOld(String day) {
        List<OldFile> out = new ArrayList<>();
        for (String sub : new String[]{"", "raw"}) {
            String rel = REL + day + "/" + (sub.isEmpty() ? "" : sub + "/");
            try (Cursor c = cr.query(coll, new String[]{MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE},
                    MediaStore.MediaColumns.RELATIVE_PATH + "=?", new String[]{rel}, MediaStore.MediaColumns.DISPLAY_NAME)) {
                while (c != null && c.moveToNext())
                    out.add(new OldFile(day, sub, c.getString(1), c.getLong(2), Uri.withAppendedPath(coll, String.valueOf(c.getLong(0)))));
            }
        }
        return out;
    }

    @Override public byte[] readOld(OldFile f) throws IOException {
        try (InputStream in = cr.openInputStream((Uri) f.handle)) {
            if (in == null) throw new IOException("cannot open " + f);
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            Library.copy(in, o);
            return o.toByteArray();
        }
    }

    @Override public boolean deleteOld(OldFile f) {
        try { return cr.delete((Uri) f.handle, null, null) > 0; } catch (Exception e) { return false; }
    }

    @Override public void removeOldDirIfEmpty(String day) {
        File base = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), Protocol.ROOT + "/" + day);
        try { new File(base, "raw").delete(); base.delete(); } catch (Exception ignored) {} // only empty folders go
    }
}
