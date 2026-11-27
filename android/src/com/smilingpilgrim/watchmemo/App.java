package com.smilingpilgrim.watchmemo;

import android.app.Application;
import android.os.Build;
import android.os.Environment;
import com.smilingpilgrim.watchmemo.core.*;
import java.io.File;
import java.util.TimeZone;

/**
 * 0.2.4 (item 12, option A): the receiver belongs to the process, not to MainActivity, so it
 * survives the Activity being destroyed. No foreground service, no new permission.
 */
public class App extends Application {
    private Receiver rx;

    public synchronized Receiver receiver() {
        if (rx == null) {
            SharedFolder shared = Build.VERSION.SDK_INT >= 29 ? new MediaStoreShared(this)
                    : new FileShared(new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), Protocol.ROOT));
            MemoService.Listener sys = new MemoService.Listener() {
                @Override public void onSaved(Entry e, int today, boolean duplicate) {}
                @Override public void onLog(String line) { android.util.Log.i("WatchMemo", line); }
            };
            Library lib = new Library(getFilesDir(), shared, sys::onLog);
            rx = new Receiver(lib, TimeZone.getDefault(), Protocol.PORT, sys);
        }
        return rx;
    }
}
