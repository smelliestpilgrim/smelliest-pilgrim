package com.smilingpilgrim.watchmemo.core;

/**
 * Structural check of an Ogg Opus file: every page has the OggS magic and a
 * correct CRC, the first packet is OpusHead, the second OpusTags, and there is
 * at least one audio packet. Returns null if fine, or the reason it isn't.
 */
public final class OggCheck {
    public static final class Info { public int pages, audioPackets; public long lastGranule; public long durationMs() {
        return Math.max(0, (lastGranule - OggOpus.PRE_SKIP)) / 48; } }

    public static Info check(byte[] b) throws IllegalArgumentException {
        Info info = new Info();
        int off = 0, packetNo = 0;
        boolean continued = false;
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

    private static boolean magic(byte[] b, int at, String m) {
        if (at + m.length() > b.length) return false;
        for (int i = 0; i < m.length(); i++) if (b[at + i] != m.charAt(i)) return false;
        return true;
    }

    private OggCheck() {}
}
