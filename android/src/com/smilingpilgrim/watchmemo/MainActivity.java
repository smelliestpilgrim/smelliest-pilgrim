package com.smilingpilgrim.watchmemo;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import com.smilingpilgrim.watchmemo.core.*;
import java.io.File;
import java.text.SimpleDateFormat;
import java.util.*;

/**
 * Smelliest Pilgrim (formerly WatchMemo) 0.2: a library of days, plus the receiver.
 * While the app is open, a tiny server on 127.0.0.1:8765 takes memos from the watch (via the Zepp app).
 * Memos live in private storage; Documents/WatchMemos/ only gets one zip per day.
 *
 * High-contrast layout: white on black, nothing coded by colour alone; a small title at the top,
 * content and big buttons in the middle and bottom of the screen.
 */
public class MainActivity extends Activity implements MemoService.Listener {
    private static final int WHITE = Color.WHITE, SOFT = 0xFFDDDDDD, DIM = 0xFFAAAAAA;
    private Http http;
    private MemoService service;
    private Library lib;
    private Places places;
    private SharedPreferences prefs;
    private final Handler h = new Handler(Looper.getMainLooper());

    private TextView title, status;
    private FrameLayout content;
    private LinearLayout buttons;
    private String openDay = null;          // null = list of days
    private int sessionCount = 0;
    private String serverState = "Starting…";
    private MediaPlayer player; private String playingFile; private Button playingBtn; private TextView playingInfo; private PlotView plot;
    private volatile boolean ready = false;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences("ui", MODE_PRIVATE);
        SharedFolder shared = Build.VERSION.SDK_INT >= 29 ? new MediaStoreShared(this)
                : new FileShared(new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), Protocol.ROOT));
        lib = new Library(getFilesDir(), shared, this::onLog);
        service = new MemoService(lib, TimeZone.getDefault(), this);
        places = new Places(this, () -> ui(this::refresh));
        buildFrame();
        if (Build.VERSION.SDK_INT < 29 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 1);
        }
        showList();
        new Thread(() -> {
            // Import 0.1.x folders and repair zips first, then open the receiver: never both at once.
            try {
                if (!lib.shared().oldDays().isEmpty()) { serverState = "Importing old folders…"; ui(this::updateStatus); }
                new Migration(lib, TimeZone.getDefault(), this::onLog).run();
                lib.heal();
            } catch (Exception e) { onLog("startup: " + e); }
            ready = true;
            ui(this::refresh);
            startServer();
        }, "startup").start();
    }

    private void startServer() {
        http = new Http(service, Protocol.PORT);
        try {
            http.start();
            serverState = "Receiver ready";
        } catch (Exception e) {
            serverState = "RECEIVER FAILED: " + e.getMessage() + " – close the app from Recents and reopen";
        }
        ui(this::updateStatus);
    }

    @Override protected void onDestroy() {
        if (http != null) http.stop();
        stopPlayer();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (openDay != null) showList(); else super.onBackPressed();
    }

    // ---------- frame: [title area] [content] [buttons] [status] ----------
    private void buildFrame() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.BLACK);
        int screenH = getResources().getDisplayMetrics().heightPixels;
        title = new TextView(this);
        title.setTextColor(DIM); title.setTextSize(16);
        title.setGravity(Gravity.BOTTOM | Gravity.START);
        title.setPadding(dp(20), 0, dp(20), dp(8));
        root.addView(title, new LinearLayout.LayoutParams(-1, (int) (screenH * 0.16)));
        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setPadding(dp(12), dp(8), dp(12), 0);
        root.addView(buttons, new LinearLayout.LayoutParams(-1, -2));
        status = new TextView(this);
        status.setTextColor(SOFT); status.setTextSize(15);
        status.setPadding(dp(20), dp(8), dp(20), dp(14));
        root.addView(status, new LinearLayout.LayoutParams(-1, -2));
        setContentView(root);
    }

    private void updateStatus() {
        int today = 0;
        try { today = service.today().entries.size(); } catch (Exception ignored) {}
        status.setText(serverState + " · received now: " + sessionCount + " · today: " + today);
    }

    private void refresh() { if (openDay == null) showList(); else showDay(openDay); }

    // ---------- list of days ----------
    private void showList() {
        stopPlayer();
        openDay = null;
        title.setText("Smelliest Pilgrim · days");
        ScrollView sv = new ScrollView(this);
        LinearLayout l = column(sv);
        List<String> days = lib.days();
        if (days.isEmpty()) {
            text(l, 22, WHITE, false, ready ? "No memos yet.\n\nKeep this app open, then on the watch press your Memo button and SEND ALL."
                    : "Loading…");
        }
        boolean towns = prefs.getBoolean("towns", false);
        for (String day : days) {
            DayLog dl = lib.day(day);
            LinearLayout card = card(l);
            text(card, 26, WHITE, true, niceDay(day));
            int n = dl.entries.size();
            text(card, 22, WHITE, false, n + (n == 1 ? " memo" : " memos") + " · " + minutes(dl.totalMs()));
            Entry a = dl.firstFix(), z = dl.lastFix();
            if (a == null) text(card, 19, SOFT, false, "No GPS positions");
            else if (a == z) text(card, 19, SOFT, false, "At " + place(a, towns));
            else { text(card, 19, SOFT, false, "From " + place(a, towns)); text(card, 19, SOFT, false, "To " + place(z, towns)); }
            card.setContentDescription(niceDay(day) + ", " + n + " memos. Tap to open.");
            card.setOnClickListener(v -> showDay(day));
        }
        List<String> notes = lib.notes();
        if (!notes.isEmpty()) {
            LinearLayout nc = card(l);
            text(nc, 20, WHITE, true, "Note about old folders");
            for (String s : notes) text(nc, 17, SOFT, false, "• " + s);
            Button ok = button(nc, "Got it, hide this note");
            ok.setOnClickListener(v -> { lib.clearNotes(); showList(); });
        }
        text(l, 15, DIM, false, "Zips are saved to " + lib.shared().describe() + "/ as WatchMemos_<date>.zip");
        swap(sv);
        buttons.removeAllViews();
        Button t = button(buttons, towns ? "Town names: ON" : "Town names: OFF");
        t.setContentDescription(towns ? "Town names on. Uses the internet once per place. Tap to turn off." : "Town names off. Tap to turn on; uses the internet once per place.");
        t.setOnClickListener(v -> { prefs.edit().putBoolean("towns", !towns).apply(); showList(); });
        updateStatus();
    }

    private String place(Entry e, boolean towns) {
        String n = places.name(e.lat, e.lon, towns);
        String ll = String.format(Locale.ROOT, "%.4f, %.4f", e.lat, e.lon);
        return n == null ? ll : n + "  (" + ll + ")";
    }

    // ---------- one day ----------
    private void showDay(String day) {
        stopPlayer();
        openDay = day;
        title.setText("Smelliest Pilgrim · " + day);
        DayLog dl = lib.day(day);
        ScrollView sv = new ScrollView(this);
        LinearLayout l = column(sv);
        text(l, 26, WHITE, true, niceDay(day));
        text(l, 20, SOFT, false, dl.entries.size() + (dl.entries.size() == 1 ? " memo · " : " memos · ") + minutes(dl.totalMs()));
        List<PlotView.Pt> pts = new ArrayList<>();
        for (int i = 0; i < dl.entries.size(); i++) { Entry e = dl.entries.get(i); if (e.fix) pts.add(new PlotView.Pt(e.lat, e.lon, i + 1)); }
        plot = null;
        if (!pts.isEmpty()) {
            plot = new PlotView(this);
            plot.set(pts);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, dp(250));
            lp.topMargin = dp(10);
            l.addView(plot, lp);
            text(l, 15, DIM, false, "Numbers = memo order. Square = first, double ring = last. No map, no internet.");
        }
        for (int i = 0; i < dl.entries.size(); i++) {
            Entry e = dl.entries.get(i);
            int num = i + 1;
            LinearLayout card = card(l);
            text(card, 26, WHITE, true, num + " · " + e.time.substring(0, Math.min(5, e.time.length())) + "     " + Entry.dur(e.audioMs));
            if (e.fix) {
                text(card, 19, SOFT, false, String.format(Locale.ROOT, "%.5f, %.5f", e.lat, e.lon));
                String extra = (e.sats > 0 ? e.sats + " satellites" : "") + (e.fixS >= 0 ? (e.sats > 0 ? " · " : "") + "fix took " + Math.round(e.fixS) + " s" : "");
                if (!extra.isEmpty()) text(card, 17, SOFT, false, extra);
            } else text(card, 19, SOFT, false, "No GPS position");
            if (!e.note.isEmpty() && !e.file.endsWith(".ogg")) text(card, 16, SOFT, false, e.note);
            TextView info = text(card, 17, WHITE, false, "");
            info.setVisibility(View.GONE);
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            card.addView(row, new LinearLayout.LayoutParams(-1, -2));
            File audio = lib.audio(day, e.file);
            if (e.file.endsWith(".ogg") && audio.isFile()) {
                Button play = button(row, "▶  Play");
                play.setContentDescription("Play memo " + num);
                play.setOnClickListener(v -> togglePlay(audio, play, info, num, card));
            }
            if (e.fix) {
                Button map = button(row, "Open in Maps");
                map.setContentDescription("Open memo " + num + " position in Maps");
                map.setOnClickListener(v -> openMaps(e, num));
            }
        }
        if (!lib.logs(day).isEmpty()) text(l, 15, DIM, false, "Watch log in the zip: " + lib.logs(day).size() + " file(s)");
        swap(sv);
        buttons.removeAllViews();
        Button back = button(buttons, "‹  All days");
        back.setOnClickListener(v -> showList());
        Button share = button(buttons, "Share day");
        share.setContentDescription("Share the zip of " + niceDay(day));
        share.setOnClickListener(v -> shareDay(day));
        updateStatus();
    }

    private void togglePlay(File f, Button b, TextView info, int num, LinearLayout card) {
        if (player != null && f.getPath().equals(playingFile)) {
            if (player.isPlaying()) { player.pause(); b.setText("▶  Play"); info.setText("Paused at " + Entry.dur(player.getCurrentPosition())); }
            else { player.start(); b.setText("❚❚  Pause"); tick(); }
            return;
        }
        stopPlayer();
        try {
            player = new MediaPlayer();
            player.setDataSource(f.getPath());
            player.prepare();
            player.setOnCompletionListener(mp -> stopPlayer());
            player.start();
            playingFile = f.getPath(); playingBtn = b; playingInfo = info;
            b.setText("❚❚  Pause");
            info.setVisibility(View.VISIBLE);
            ((GradientDrawable) card.getBackground()).setStroke(dp(5), WHITE); // thicker frame = playing (not colour)
            card.setTag("playing");
            if (plot != null) plot.highlight(num);
            tick();
        } catch (Exception e) {
            stopPlayer();
            info.setVisibility(View.VISIBLE);
            info.setText("This phone can't play it here (" + e.getMessage() + "). The .ogg in the zip plays in VLC.");
        }
    }

    private final Runnable ticker = this::tick;
    private void tick() {
        h.removeCallbacks(ticker);
        if (player == null || playingInfo == null) return;
        try { playingInfo.setText("Playing " + Entry.dur(player.getCurrentPosition()) + " of " + Entry.dur(player.getDuration())); } catch (Exception ignored) {}
        if (player.isPlaying()) h.postDelayed(ticker, 500);
    }

    private void stopPlayer() {
        h.removeCallbacks(ticker);
        if (player != null) { try { player.release(); } catch (Exception ignored) {} player = null; }
        if (playingBtn != null) {
            playingBtn.setText("▶  Play");
            View card = (View) playingBtn.getParent().getParent();
            if (card.getBackground() instanceof GradientDrawable) ((GradientDrawable) card.getBackground()).setStroke(dp(2), WHITE);
        }
        if (playingInfo != null) playingInfo.setVisibility(View.GONE);
        if (plot != null) plot.highlight(-1);
        playingFile = null; playingBtn = null; playingInfo = null;
    }

    private void openMaps(Entry e, int num) {
        String ll = String.format(Locale.ROOT, "%.6f,%.6f", e.lat, e.lon);
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("geo:" + ll + "?q=" + ll + "(Memo " + num + ")")));
        } catch (Exception ex) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(e.mapUrl()))); }
            catch (Exception ex2) { Toast.makeText(this, "No maps or browser app found", Toast.LENGTH_LONG).show(); }
        }
    }

    private void shareDay(String day) {
        try {
            if (!lib.zip(day).isFile()) lib.rebuild(day);
            Uri u = ZipProvider.uriFor(Library.zipName(day));
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("application/zip");
            send.putExtra(Intent.EXTRA_STREAM, u);
            send.putExtra(Intent.EXTRA_SUBJECT, "Watch memos " + day);
            send.setClipData(ClipData.newRawUri(Library.zipName(day), u));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(send, "Share " + niceDay(day)));
        } catch (Exception e) {
            Toast.makeText(this, "Could not share: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    // ---------- small view helpers ----------
    private LinearLayout column(ScrollView sv) {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(dp(16), dp(4), dp(16), dp(24));
        sv.addView(l);
        return l;
    }
    private void swap(View v) { content.removeAllViews(); content.addView(v); }

    private LinearLayout card(LinearLayout parent) {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setPadding(dp(18), dp(12), dp(18), dp(14));
        GradientDrawable g = new GradientDrawable();
        g.setColor(0xFF161616); g.setStroke(dp(2), WHITE); g.setCornerRadius(dp(14));
        c.setBackground(g);
        c.setMinimumHeight(dp(88));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(14);
        parent.addView(c, lp);
        return c;
    }

    private TextView text(LinearLayout parent, float sp, int color, boolean bold, String s) {
        TextView t = new TextView(this);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(3), 0, dp(3));
        t.setText(s);
        parent.addView(t);
        return t;
    }

    private Button button(LinearLayout parent, String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21);
        b.setTextColor(WHITE);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable g = new GradientDrawable();
        g.setColor(Color.BLACK); g.setStroke(dp(3), WHITE); g.setCornerRadius(dp(12));
        b.setBackground(g);
        b.setMinHeight(dp(64));
        LinearLayout.LayoutParams lp = parent.getOrientation() == LinearLayout.HORIZONTAL
                ? new LinearLayout.LayoutParams(0, dp(64), 1) : new LinearLayout.LayoutParams(-1, dp(64));
        lp.setMargins(dp(4), dp(8), dp(4), dp(4));
        parent.addView(b, lp);
        return b;
    }

    private static String niceDay(String day) {
        try {
            SimpleDateFormat in = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
            return new SimpleDateFormat("EEEE d MMM yyyy", Locale.getDefault()).format(in.parse(day));
        } catch (Exception e) { return day; }
    }
    private static String minutes(long ms) {
        long s = Math.round(ms / 1000.0);
        if (s < 60) return s + " s total";
        return (s / 60) + " min " + (s % 60) + " s total";
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private void ui(Runnable r) { runOnUiThread(r); }

    // ---------- receiver callbacks ----------
    @Override public void onSaved(Entry e, int today, boolean duplicate) {
        ui(() -> {
            if (!duplicate) sessionCount++;
            if (openDay == null || player == null) refresh(); else updateStatus();
        });
    }

    @Override public void onLog(String line) { android.util.Log.i("WatchMemo", line); }
}
