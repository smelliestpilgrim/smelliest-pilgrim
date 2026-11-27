package com.smilingpilgrim.watchmemo.core;

import java.io.File;
import java.io.IOException;
import java.util.List;

/**
 * The visible folder Documents/WatchMemos/. From 0.2.0 it only ever holds
 * WatchMemos_YYYY-MM-DD.zip. The "old" methods read the 0.1.x day folders
 * (Documents/WatchMemos/YYYY-MM-DD/ and its raw/ subfolder) for the one-time import.
 */
public interface SharedFolder {
    final class OldFile {
        public final String day, sub, name; public final long size; public final Object handle;
        public OldFile(String day, String sub, String name, long size, Object handle) {
            this.day = day; this.sub = sub == null ? "" : sub; this.name = name; this.size = size; this.handle = handle;
        }
        public String path() { return day + "/" + (sub.isEmpty() ? "" : sub + "/") + name; }
        @Override public String toString() { return path(); }
    }

    /** Human-readable location, for the UI. */
    String describe();
    /** Replace Documents/WatchMemos/{name} with a copy of src, never leaving a half-written file under that name. */
    void publish(String name, File src) throws IOException;
    /** Size of Documents/WatchMemos/{name}, or -1 if it isn't there. With duplicate rows: the newest one. */
    long size(String name);

    /**
     * Which of several MediaStore rows with the same name counts: the newest, i.e. the highest _ID
     * (MediaStore ids only grow, and publish() always inserts the new copy as a new row before it
     * removes the old ones). -1 if there are none. Deterministic whatever order the query returns.
     */
    static int newest(long[] ids) {
        int best = -1;
        for (int i = 0; i < ids.length; i++) if (best < 0 || ids[i] > ids[best]) best = i;
        return best;
    }

    List<String> oldDays();
    List<OldFile> listOld(String day);
    byte[] readOld(OldFile f) throws IOException;
    boolean deleteOld(OldFile f);
    /** Remove the empty YYYY-MM-DD (and raw/) folders, if the platform needs that. */
    void removeOldDirIfEmpty(String day);
}
