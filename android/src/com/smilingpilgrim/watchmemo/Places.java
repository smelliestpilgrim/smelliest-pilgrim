package com.smilingpilgrim.watchmemo;

import android.content.Context;
import android.location.Address;
import android.location.Geocoder;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/**
 * Optional town names. OFF by default: Android's Geocoder asks an online service.
 * Never blocks the UI: lookups run on one background thread, results are cached in
 * files/places.tsv (rounded to ~100 m) so each place is asked once, then works offline.
 */
final class Places {
    interface Done { void changed(); }
    private final File cache;
    private final Map<String, String> map = new HashMap<>();
    private final Set<String> asked = new HashSet<>();
    private final ExecutorService ex = Executors.newSingleThreadExecutor();
    private final Context ctx;
    private final Done done;

    Places(Context c, Done d) {
        ctx = c.getApplicationContext(); done = d; cache = new File(ctx.getFilesDir(), "places.tsv");
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(cache), StandardCharsets.UTF_8))) {
            String l; while ((l = r.readLine()) != null) { String[] p = l.split("\t"); if (p.length == 2) map.put(p[0], p[1]); }
        } catch (IOException ignored) {}
    }

    static String key(double lat, double lon) { return String.format(Locale.ROOT, "%.3f,%.3f", lat, lon); }

    /** Cached name, or null (and, if lookups are on, ask in the background). */
    synchronized String name(double lat, double lon, boolean lookup) {
        String k = key(lat, lon);
        String n = map.get(k);
        if (n != null) return n.isEmpty() ? null : n;
        if (lookup && Geocoder.isPresent() && asked.add(k)) ex.execute(() -> fetch(k, lat, lon));
        return null;
    }

    private void fetch(String k, double lat, double lon) {
        String n = "";
        try {
            @SuppressWarnings("deprecation")
            List<Address> a = new Geocoder(ctx, Locale.getDefault()).getFromLocation(lat, lon, 1);
            if (a != null && !a.isEmpty()) {
                Address ad = a.get(0);
                n = ad.getLocality() != null ? ad.getLocality() : ad.getSubAdminArea() != null ? ad.getSubAdminArea() : "";
            }
        } catch (Exception e) { return; } // offline: try again another time
        synchronized (this) {
            map.put(k, n);
            try (Writer w = new OutputStreamWriter(new FileOutputStream(cache, true), StandardCharsets.UTF_8)) { w.write(k + "\t" + n + "\n"); }
            catch (IOException ignored) {}
        }
        if (!n.isEmpty()) done.changed();
    }
}
