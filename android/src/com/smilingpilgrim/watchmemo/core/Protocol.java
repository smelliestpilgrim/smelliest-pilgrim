package com.smilingpilgrim.watchmemo.core;

/** Mirrors watch/utils/protocol.js. Change PORT in both places or neither. */
public final class Protocol {
    public static final int PORT = 8765;
    public static final String VERSION = "0.2.4"; // = versionName; /ping reports it. The watch only logs it (it keys on "offsets":true).
    public static final int MAX_BODY = 64 * 1024;         // a 16 KB chunk is ~22 KB of base64
    public static final int MAX_CHUNK_BYTES = 48 * 1024;  // 0.2.2 offset chunks: decoded size cap
    public static final long MAX_MEMO_BYTES = 64L * 1024 * 1024; // offset store: one memo
    public static final int MAX_CHUNKS = 16384;            // 32 MB per memo at 2 KB chunks
    public static final String ROOT = "WatchMemos";        // under Documents/
    // Protocol identity, deliberately NOT renamed to "Smelliest Pilgrim" (27 Nov 2026):
    // /ping "app":"WatchMemo", the Ogg vendor "WatchMemo" (OggOpus; server/public/opus.js
    // must stay byte-identical), the log tag "WatchMemo" and the server's "protocol":"WatchMemo".
    private Protocol() {}
}
