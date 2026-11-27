package com.smilingpilgrim.watchmemo.core;

import java.util.ArrayList;
import java.util.List;

/**
 * The watch recorder writes Opus packets in the opus_demo layout, not Ogg:
 * per packet a 4-byte big-endian length, 4 bytes of encoder range state, then the packet.
 * 16 kHz mono (per Zepp's FAQ).
 */
public final class ZeppOpus {
    public static final class Parsed {
        public final List<byte[]> packets = new ArrayList<>();
        public int usedBytes;      // bytes consumed by complete packets
        public int totalBytes;
        public long samples48k;    // sum of packet durations at 48 kHz
        public boolean truncated() { return usedBytes != totalBytes; }
        public long durationMs() { return samples48k / 48; }
    }

    public static Parsed parse(byte[] data) {
        Parsed p = new Parsed();
        p.totalBytes = data.length;
        int off = 0;
        while (off + 8 <= data.length) {
            long len = ((data[off] & 0xffL) << 24) | ((data[off + 1] & 0xff) << 16)
                    | ((data[off + 2] & 0xff) << 8) | (data[off + 3] & 0xff);
            if (len <= 0 || len > 1275 * 3 || off + 8 + len > data.length) break;
            byte[] pkt = new byte[(int) len];
            System.arraycopy(data, off + 8, pkt, 0, (int) len);
            p.packets.add(pkt);
            p.samples48k += samples48k(pkt);
            off += 8 + (int) len;
        }
        p.usedBytes = off;
        return p;
    }

    /** Samples in one Opus packet at 48 kHz, from its TOC byte (RFC 6716 3.1). */
    public static int samples48k(byte[] pkt) {
        if (pkt.length < 1) return 0;
        int toc = pkt[0] & 0xff;
        int config = toc >> 3;
        int frame;
        if (config < 12) frame = new int[]{480, 960, 1920, 2880}[config & 3];
        else if (config < 16) frame = new int[]{480, 960}[config & 1];
        else frame = new int[]{120, 240, 480, 960}[config & 3];
        int code = toc & 3;
        int count;
        if (code == 0) count = 1;
        else if (code == 1 || code == 2) count = 2;
        else count = pkt.length > 1 ? (pkt[1] & 0x3f) : 0;
        return frame * count;
    }

    private ZeppOpus() {}
}
