package com.smilingpilgrim.watchmemo.core;

/**
 * Structural check of an Ogg Opus file: every page has the OggS magic and a
 * correct CRC, the first packet is OpusHead, the second OpusTags, and there is
 * at least one audio packet. Returns null if fine, or the reason it isn't.
 * 0.2.4 also checks (RFC 7845 / RFC 3533): OpusHead fields (version 0.x, 1..255 channels,
 * mapping family 0 = 1 or 2 channels and a 19-byte header), one serial number on every page,
 * and page sequence numbers 0, 1, 2, ... with no gap. Pre-skip and input rate are read and
 * reported, not required to be particular values (any conforming encoder's file passes).
 */
public final class OggCheck {
    public static final class Info { public int pages, audioPackets, channels, preSkip; public long lastGranule, inputRate, serial; public long durationMs() {
        return Math.max(0, (lastGranule - OggOpus.PRE_SKIP)) / 48; } }

    public static Info check(byte[] b) throws IllegalArgumentException {
        Info info = new Info();
        int off = 0, packetNo = 0;
        boolean continued = false;
        long serial0 = 0;
        while (off < b.length) {
            if (off + 27 > b.length) throw new IllegalArgumentException("truncated page header at " + off);
            if (b[off] != 'O' || b[off + 1] != 'g' || b[off + 2] != 'g' || b[off + 3] != 'S') throw new IllegalArgumentException("no OggS at " + off);
            int nseg = b[off + 26] & 0xff;
            if (off + 27 + nseg > b.length) throw new IllegalArgumentException("truncated segment table");
            int body = 0;
            for (int i = 0; i < nseg; i++) body += b[off + 27 + i] & 0xff;
            int len = 27 + nseg + body;
            if (off + len > b.length) throw new IllegalArgumentException("truncated page body at " + off);
            int stored = (b[off + 22] & 0xff) | (b[off + 23] & 0xff) << 8 | (b[off + 24] & 0xff) << 16 | (b[off + 25] & 0xff) << 24;
            byte[] copy = new byte[len];
            System.arraycopy(b, off, copy, 0, len);
            copy[22] = copy[23] = copy[24] = copy[25] = 0;
            if (OggOpus.crc(copy, 0, len) != stored) throw new IllegalArgumentException("bad CRC on page " + info.pages);
            long serial = le32(b, off + 14), seq = le32(b, off + 18);
            if (info.pages == 0) { serial0 = serial; info.serial = serial; }
            else if (serial != serial0) throw new IllegalArgumentException("page " + info.pages + " has serial " + serial + ", first page had " + serial0);
            if (seq != info.pages) throw new IllegalArgumentException("page " + info.pages + " has sequence number " + seq + " (a page is missing or out of order)");
            long g = 0;
            for (int i = 7; i >= 0; i--) g = (g << 8) | (b[off + 6 + i] & 0xff);
            if (g != -1) info.lastGranule = g;
            // packets: a lacing value < 255 ends a packet
            int p = off + 27 + nseg, pktStart = p;
            for (int i = 0; i < nseg; i++) {
                int lv = b[off + 27 + i] & 0xff;
                p += lv;
                if (lv < 255) {
                    if (!continued) {
                        if (packetNo == 0 && !magic(b, pktStart, "OpusHead")) throw new IllegalArgumentException("first packet is not OpusHead");
                        if (packetNo == 0) opusHead(b, pktStart, p - pktStart, info);
                        if (packetNo == 1 && !magic(b, pktStart, "OpusTags")) throw new IllegalArgumentException("second packet is not OpusTags");
                    }
                    if (packetNo >= 2) info.audioPackets++;
                    packetNo++;
                    continued = false;
                    pktStart = p;
                } else continued = true;
            }
            info.pages++;
            off += len;
        }
        if (info.audioPackets == 0) throw new IllegalArgumentException("no audio packets");
        return info;
    }

    /** RFC 7845 section 5.1. */
    private static void opusHead(byte[] b, int at, int len, Info info) {
        if (len < 19) throw new IllegalArgumentException("OpusHead is " + len + " bytes, need 19");
        int version = b[at + 8] & 0xff, ch = b[at + 9] & 0xff, family = b[at + 18] & 0xff;
        if ((version & 0xf0) != 0) throw new IllegalArgumentException("OpusHead version " + version + " not supported");
        if (ch == 0) throw new IllegalArgumentException("OpusHead says 0 channels");
        if (family == 0 && (ch > 2 || len != 19)) throw new IllegalArgumentException("OpusHead mapping family 0 with " + ch + " channels / " + len + " bytes");
        if (family != 0 && len < 21 + ch) throw new IllegalArgumentException("OpusHead channel mapping table too short");
        info.channels = ch;
        info.preSkip = (b[at + 10] & 0xff) | (b[at + 11] & 0xff) << 8;
        info.inputRate = le32(b, at + 12);
    }

    private static long le32(byte[] b, int o) {
        return ((b[o] & 0xffL) | (b[o + 1] & 0xffL) << 8 | (b[o + 2] & 0xffL) << 16 | (b[o + 3] & 0xffL) << 24);
    }

    private static boolean magic(byte[] b, int at, String m) {
        if (at + m.length() > b.length) return false;
        for (int i = 0; i < m.length(); i++) if (b[at + i] != m.charAt(i)) return false;
        return true;
    }

    private OggCheck() {}
}
