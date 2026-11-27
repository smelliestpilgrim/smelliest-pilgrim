# Smelliest Pilgrim: phone app (Android)

Formerly called WatchMemo. Receives memos from the watch app through the Zepp
app on the same phone (`127.0.0.1:8765`), keeps them in private storage, and
writes one zip per day (`.ogg` files, `day.md` with times and places, the watch
log) to `Documents/WatchMemos/`. Package `com.smilingpilgrim.watchmemo`; the
folder and package names stay the same so updates keep your memos.

Build: `./build.sh` (JDK 17, Android SDK build-tools 34.0.0, platform android-34,
no Gradle). Without `WM_KEYSTORE` it signs with a throwaway debug key, which
cannot update an installed release. Release builds are signed with a key that is
not in this repository.

Tests: `test/TestMain.java`, run by `../run_tests.sh`.
