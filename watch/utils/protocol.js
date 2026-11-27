// Shared constants for the watch page, the Side Service and (mirrored by hand)
// the companion APK: phone/src/com/smilingpilgrim/watchmemo/core/Protocol.java.
// Change PORT in both places or neither.

export const PORT = 8765
export const BASE_URL = 'http://127.0.0.1:' + PORT

// Raw audio bytes per message. Base64 makes each message ~2.7 KB.
// CHUNK_BYTES is the proven 0.1.2/0.1.3 size: the log upload and any caller
// that does not pick a size still use it.
export const CHUNK_BYTES = 2048
// 0.1.4: chunk sizes the user can cycle on the Send page (single taps).
// ZML 0.0.9 cuts every request into BLE frames of 3518 payload bytes
// (3600 with headers) and pushes them back to back with no flow control.
// One chunk's JSON is ~100 bytes + base64 (4/3 of the raw size), so:
//    2 KB -> ~2.8 KB  = 1 frame (proven in the field, 2.1 KB/s)
//    5 KB -> ~6.9 KB  = 2 frames (full)
//   10 KB -> ~13.8 KB = 4 frames (full)
//   16 KB -> ~21.9 KB = 7 frames (test: more than the "queue limit(5)"
//                       one Zepp developer hit, so it may be refused)
// Sizes are picked to fill whole frames. The phone accepts up to 64 KB of
// body, so the phone is never the limit here.
export const CHUNK_SIZES = [2048, 5120, 10240, 16384]
export const DEFAULT_CHUNK = 10240
export const FALLBACK_AFTER = 2 // size-type errors on one chunk before dropping a size
export const CHUNK_TIMEOUT_MS = 15000 // per 2 KB chunk round trip watch -> phone app -> watch
export const CHUNK_TIMEOUT_PER_KB_MS = 1000 // bigger chunks get longer (16 KB: 29 s; ZML's own cap is 60 s)
export function chunkTimeout(bytes) {
  return CHUNK_TIMEOUT_MS + Math.max(0, Math.ceil((bytes - 2048) / 1024)) * CHUNK_TIMEOUT_PER_KB_MS
}
export function chunkLabel(bytes) {
  return Math.round(bytes / 1024) + 'K'
}
export const CHUNK_RETRIES = 12 // max tries for one chunk/commit while the link is up
// 0.1.3: retry with backoff instead of failing the memo. Waits between tries
// (the last value repeats). A step gives up only after STALL_LIMIT_MS without
// any progress, so one press of Send rides out Bluetooth drops, shake
// timeouts and a WatchMemo app that still has to be opened.
export const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000]
export const STALL_LIMIT_MS = 3 * 60 * 1000
export const LOG_STALL_LIMIT_MS = 60 * 1000 // the breadcrumb log is less precious
export const LINK_POLL_MS = 1000 // while BLE is down, check every second
export const LINK_SETTLE_MS = 1500 // after BLE comes back, give it a moment
export const COMMIT_TIMEOUT_MS = 20000
export const PING_TIMEOUT_MS = 10000

export const MEMO_DIR = 'memos' // inside the app's data:// folder
