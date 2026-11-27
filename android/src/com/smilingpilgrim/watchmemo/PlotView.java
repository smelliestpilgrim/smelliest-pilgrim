package com.smilingpilgrim.watchmemo;

import android.content.Context;
import android.graphics.*;
import android.view.View;
import java.util.ArrayList;
import java.util.List;

/**
 * The day's positions as numbered circles joined in time order. No map tiles, no network.
 * Numbers match the memo list; first point is a square, last a double circle, so shape
 * (not colour) tells start from end. North is up; 1 km scale bar at the bottom.
 */
final class PlotView extends View {
    static final class Pt { final double lat, lon; final int n; Pt(double a, double o, int n) { lat = a; lon = o; this.n = n; } }
    private final List<Pt> pts = new ArrayList<>();
    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG), ring = new Paint(Paint.ANTI_ALIAS_FLAG),
            fill = new Paint(Paint.ANTI_ALIAS_FLAG), text = new Paint(Paint.ANTI_ALIAS_FLAG), small = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final float d;
    private int highlight = -1;

    PlotView(Context c) {
        super(c);
        d = getResources().getDisplayMetrics().density;
        line.setColor(0xFF9E9E9E); line.setStrokeWidth(2.5f * d); line.setStyle(Paint.Style.STROKE);
        line.setPathEffect(new DashPathEffect(new float[]{8 * d, 6 * d}, 0));
        ring.setColor(Color.WHITE); ring.setStrokeWidth(3 * d); ring.setStyle(Paint.Style.STROKE);
        fill.setColor(Color.BLACK); fill.setStyle(Paint.Style.FILL);
        text.setColor(Color.WHITE); text.setTextSize(17 * d); text.setTypeface(Typeface.DEFAULT_BOLD); text.setTextAlign(Paint.Align.CENTER);
        small.setColor(0xFFDDDDDD); small.setTextSize(14 * d);
        setContentDescription("Plot of the day's positions in time order");
    }

    void set(List<Pt> p) { pts.clear(); pts.addAll(p); invalidate(); }
    void highlight(int n) { highlight = n; invalidate(); }

    @Override protected void onDraw(Canvas c) {
        int w = getWidth(), h = getHeight();
        Paint frame = new Paint(ring); frame.setStrokeWidth(1.5f * d); frame.setColor(0xFF777777);
        c.drawRect(1, 1, w - 1, h - 1, frame);
        if (pts.isEmpty()) { c.drawText("No GPS positions this day", 16 * d, h / 2f, small); return; }
        double minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (Pt p : pts) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); }
        double k = Math.cos(Math.toRadians((minLat + maxLat) / 2));
        double spanX = Math.max((maxLon - minLon) * k, 0.002), spanY = Math.max(maxLat - minLat, 0.002); // at least ~200 m
        float pad = 30 * d, bottom = 34 * d;
        double s = Math.min((w - 2 * pad) / spanX, (h - pad - bottom) / spanY);
        double cx = (minLon + maxLon) / 2, cy = (minLat + maxLat) / 2;
        float ox = w / 2f, oy = (h - bottom + pad) / 2f;
        float[] xs = new float[pts.size()], ys = new float[pts.size()];
        for (int i = 0; i < pts.size(); i++) {
            xs[i] = (float) (ox + (pts.get(i).lon - cx) * k * s);
            ys[i] = (float) (oy - (pts.get(i).lat - cy) * s);
        }
        Path path = new Path();
        for (int i = 0; i < xs.length; i++) { if (i == 0) path.moveTo(xs[i], ys[i]); else path.lineTo(xs[i], ys[i]); }
        c.drawPath(path, line);
        float r = 15 * d;
        for (int i = 0; i < xs.length; i++) {
            Pt p = pts.get(i);
            boolean hi = p.n == highlight;
            Paint rg = new Paint(ring); if (hi) rg.setStrokeWidth(6 * d);
            if (i == 0) { c.drawRect(xs[i] - r, ys[i] - r, xs[i] + r, ys[i] + r, fill); c.drawRect(xs[i] - r, ys[i] - r, xs[i] + r, ys[i] + r, rg); }
            else {
                c.drawCircle(xs[i], ys[i], r, fill); c.drawCircle(xs[i], ys[i], r, rg);
                if (i == xs.length - 1 && xs.length > 1) c.drawCircle(xs[i], ys[i], r + 5 * d, rg);
            }
            c.drawText(String.valueOf(p.n), xs[i], ys[i] + 6 * d, text);
        }
        // scale bar: 1 km, or 100 m if the day is small
        double metresPerPx = 111320.0 / s;
        int m = metresPerPx * (w * 0.4) >= 1000 ? 1000 : 100;
        float len = (float) (m / metresPerPx);
        float y = h - 14 * d;
        Paint sb = new Paint(ring); sb.setStrokeWidth(3 * d);
        c.drawLine(16 * d, y, 16 * d + len, y, sb);
        c.drawText(m == 1000 ? "1 km" : "100 m", 22 * d + len, y + 5 * d, small);
        small.setTextAlign(Paint.Align.RIGHT);
        c.drawText("N ↑", w - 12 * d, y + 5 * d, small);
        small.setTextAlign(Paint.Align.LEFT);
    }
}
