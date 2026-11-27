package com.smilingpilgrim.watchmemo.core;

/** Mirrors watch/utils/protocol.js. Change PORT in both places or neither. */
public final class Protocol {
    public static final int PORT = 8765;
    public static final String VERSION = "0.2.2";
    public static final int MAX_BODY = 64 * 1024;         // a 16 KB chunk is ~22 KB of base64
    public static final int MAX_CHUNK_BYTES = 48 * 1024;  // 0.2.2 offset chunks: decoded size cap
    public static final long MAX_MEMO_BYTES = 64L * 1024 * 1024; // offset store: one memo
    public static final int MAX_CHUNKS = 16384;            // 32 MB per memo at 2 KB chunks
    public static final String ROOT = "WatchMemos";        // under Documents/
    private Protocol() {}
}
