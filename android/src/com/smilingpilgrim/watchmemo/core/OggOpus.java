package com.smilingpilgrim.watchmemo.core;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Wraps raw Opus packets into a standard Ogg Opus file (RFC 7845):
 * OpusHead page, OpusTags page, then audio pages. Granule positions are
 * counted at 48 kHz as the spec requires, whatever the input rate.
 */
public final class OggOpus {
    private static final int[] CRC = new int[256];
    static {
        for (int i = 0; i < 256; i++) {
            int r = i << 24;
            for (int k = 0; k < 8; k++) r = (r & 0x80000000) != 0 ? (r << 1) ^ 0x04C11DB7 : r << 1;
            CRC[i] = r;
        }
    }

    static int crc(byte[] b, int off, int len) {
        int c = 0;
        for (int i = off; i < off + len; i++) c = (c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 0xff];
        return c;
    }

    public static final int PRE_SKIP = 312;   // 6.5 ms, standard libopus encoder delay at 48 kHz
    private static final int MAX_PAGE_PAYLOAD = 4000;

    public static byte[] build(List<byte[]> packets, int inputRate, int serial, String title) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int seq = 0;
        // OpusHead
        byte[] head = new byte[19];
        System.arraycopy("OpusHead".getBytes(StandardCharsets.US_ASCII), 0, head, 0, 8);
        head[8] = 1; head[9] = 1; // version, channels
        le16(head, 10, PRE_SKIP);
        le32(head, 12, inputRate);
        le16(head, 16, 0); head[18] = 0;
        page(out, 0x02, 0, serial, seq++, new byte[][]{head}, 0, 1);
        // OpusTags
        byte[] vendor = "WatchMemo".getBytes(StandardCharsets.UTF_8);
        byte[] comment = title == null ? null : ("TITLE=" + title).getBytes(StandardCharsets.UTF_8);
        int tl = 8 + 4 + vendor.length + 4 + (comment == null ? 0 : 4 + comment.length);
        byte[] tags = new byte[tl];
        int o = 0;
        System.arraycopy("OpusTags".getBytes(StandardCharsets.US_ASCII), 0, tags, 0, 8); o = 8;
        le32(tags, o, vendor.length); o += 4;
        System.arraycopy(vendor, 0, tags, o, vendor.length); o += vendor.length;
        le32(tags, o, comment == null ? 0 : 1); o += 4;
        if (comment != null) { le32(tags, o, comment.length); o += 4; System.arraycopy(comment, 0, tags, o, comment.length); }
        page(out, 0x00, 0, serial, seq++, new byte[][]{tags}, 0, 1);
        // audio
        long granule = 0;
        byte[][] arr = packets.toArray(new byte[0][]);
        int start = 0;
        if (arr.length == 0) {
            page(out, 0x04, 0, serial, seq, new byte[0][], 0, 0);
            return out.toByteArray();
        }
        while (start < arr.length) {
            int end = start, bytes = 0, segs = 0;
            while (end < arr.length) {
                int s = arr[end].length / 255 + 1;
                if (end > start && (segs + s > 255 || bytes + arr[end].length > MAX_PAGE_PAYLOAD)) break;
                segs += s; bytes += arr[end].length;
                granule += ZeppOpus.samples48k(arr[end]);
                end++;
            }
            boolean last = end >= arr.length;
            page(out, last ? 0x04 : 0x00, granule, serial, seq++, arr, start, end - start);
            start = end;
        }
        return out.toByteArray();
    }

    private static void page(ByteArrayOutputStream out, int type, long granule, int serial, int seq,
                             byte[][] pkts, int from, int count) {
        ByteArrayOutputStream segs = new ByteArrayOutputStream();
        int body = 0;
        for (int i = from; i < from + count; i++) {
            int n = pkts[i].length;
            while (n >= 255) { segs.write(255); n -= 255; }
            segs.write(n);
            body += pkts[i].length;
        }
        byte[] st = segs.toByteArray();
        byte[] p = new byte[27 + st.length + body];
        p[0] = 'O'; p[1] = 'g'; p[2] = 'g'; p[3] = 'S'; p[4] = 0; p[5] = (byte) type;
        for (int i = 0; i < 8; i++) p[6 + i] = (byte) (granule >>> (8 * i));
        le32(p, 14, serial); le32(p, 18, seq); le32(p, 22, 0);
        p[26] = (byte) st.length;
        System.arraycopy(st, 0, p, 27, st.length);
        int o = 27 + st.length;
        for (int i = from; i < from + count; i++) { System.arraycopy(pkts[i], 0, p, o, pkts[i].length); o += pkts[i].length; }
        le32(p, 22, crc(p, 0, p.length));
        out.write(p, 0, p.length);
    }

    private static void le16(byte[] b, int o, int v) { b[o] = (byte) v; b[o + 1] = (byte) (v >> 8); }
    private static void le32(byte[] b, int o, int v) { for (int i = 0; i < 4; i++) b[o + i] = (byte) (v >>> (8 * i)); }

    private OggOpus() {}
}
