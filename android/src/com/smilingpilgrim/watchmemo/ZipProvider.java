package com.smilingpilgrim.watchmemo;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/**
 * A minimal FileProvider (androidx isn't part of this no-Gradle toolchain): serves only
 * files/zips/WatchMemos_YYYY-MM-DD.zip, read-only, to apps we grant a share to.
 * content://com.smilingpilgrim.watchmemo.files/zips/WatchMemos_2026-11-14.zip
 */
public final class ZipProvider extends ContentProvider {
    static final String AUTH = "com.smilingpilgrim.watchmemo.files";
    static Uri uriFor(String zipName) { return Uri.parse("content://" + AUTH + "/zips/" + zipName); }

    private File fileFor(Uri u) throws FileNotFoundException {
        String n = u.getLastPathSegment();
        if (u.getPathSegments().size() != 2 || !"zips".equals(u.getPathSegments().get(0)) || n == null || !n.matches("WatchMemos_\\d{4}-\\d{2}-\\d{2}\\.zip"))
            throw new FileNotFoundException(u.toString());
        File f = new File(new File(getContext().getFilesDir(), "zips"), n);
        if (!f.isFile()) throw new FileNotFoundException(n);
        return f;
    }

    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "application/zip"; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new SecurityException("read only");
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Cursor query(Uri uri, String[] proj, String sel, String[] args, String sort) {
        File f;
        try { f = fileFor(uri); } catch (FileNotFoundException e) { return null; }
        String[] cols = proj == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : proj;
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        c.addRow(row);
        return c;
    }

    @Override public Uri insert(Uri uri, ContentValues v) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String s, String[] a) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
}
