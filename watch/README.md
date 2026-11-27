# Smelliest Pilgrim: watch app (Zepp OS)

The watch half of Smelliest Pilgrim, for the Amazfit T-Rex 3 (Zepp OS 4, API 3).

- `page/index.js` the memo page: records after a two-second pause, tags the memo
  with GPS, keeps looking for a fix for a while after you stop.
- `page/menu.js` the send page (SEND ALL, GPS/screen toggles, chunk size, log).
- `page/log.js` the memo log.
- `app-side/` the Side Service that runs inside the Zepp phone app and relays
  memos to the phone app on 127.0.0.1:8765 or to your own server (HTTPS + token).
- `setting/` the settings page in the Zepp app (destination, server URL, token,
  Test connection).
- `utils/` sender (chunked, resumable, CRC-checked), protocol, storage, codec.

Build: `npm install && zeus build` (Zeus CLI 1.9+). `app.json` has
appId 1138450 (the Zepp store listing). Your own fork needs its own appId from the Zepp developer console.

Tests (no watch needed) run from the repository root: `./run_tests.sh`, plus
`node watch/test/settings-check.mjs`.
