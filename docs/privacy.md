---
title: Smelliest Pilgrim privacy statement
---

# Smelliest Pilgrim privacy statement

*[Español](es/privacy.html)*

Last updated: 27 November 2026

This covers the **Smelliest Pilgrim** watch app (Zepp OS, Amazfit T-Rex 3), its
settings page in the Zepp app, the **Smelliest Pilgrim** Android phone app
(formerly called WatchMemo) and the optional self-hosted server in the same
repository. They are made by one person (smelliestpilgrim on GitHub,
smilingpilgrim on the Zepp developer platform) and shared free of charge as
open source.

## What the apps collect

- **Voice recordings** that you start on the watch.
- **Location**: the watch's GPS position when a memo is recorded, if you allow
  the location permission. It is stored as latitude and longitude with the memo.
- **Recording details**: time, length, how the recording was stopped, and a
  short technical log of the watch app (used to find out why a send failed).

Nothing else: no contacts, no health data, no identifiers, no analytics, no ads,
no tracking.

## Where it goes

- On the **watch**, memos are kept in the app's own storage until they have
  been sent and confirmed and you delete them.
- When you press **Send**, the watch passes each memo over Bluetooth to the
  official Zepp app on your phone, which hands it to the destination you chose
  in the Zepp app (Smelliest Pilgrim > Settings):
  - **Smelliest Pilgrim phone app** (default): the Android app on the same
    phone, at the local address 127.0.0.1. Nothing leaves your phone. The app
    keeps the memos in its private storage and writes one zip per day to
    `Documents/WatchMemos`.
  - **My server** (optional): a server address and token that **you** enter.
    Memos are sent over HTTPS to that server only. You control that server and
    what happens to the data there. If you use the server in this repository on
    Cloudflare, the memos are stored in your own Cloudflare account.
- **Optional town names** (phone app, off by default): if you switch them on,
  the phone app asks Android's built-in Geocoder for the town at each memo's
  position. On most phones that is an online Google service, which receives the
  coordinates (rounded to about 100 m). Results are cached, so each place is
  asked once. Leave it off and nothing leaves the phone.
- **Open in Maps** (phone app) hands a memo's coordinates to the maps app or
  browser you pick, only when you tap it.
- **The developer receives nothing.** There is no developer server, and these
  apps send no data to the developer or to any third party.

The Zepp app is made by Zepp Health and has its own privacy policy, which covers
the Bluetooth connection it provides.

## Keeping and deleting

- Delete memos on the watch from the app (after they have been sent).
- Delete memos on the phone in the phone app or by deleting the day zips, or
  uninstall the phone app to remove everything it stored.
- On your own server, use its memo page (Delete) or remove the data there.

## Permissions

- Watch: microphone (to record), location (to tag memos), local storage.
- Android: network access (to receive memos from the Zepp app on the same phone
  at 127.0.0.1, and for the optional town names); on Android 8 and 9 only,
  storage write access for the day zips.

## Children

The apps are not directed at children.

## Contact

Open an issue at
[github.com/smelliestpilgrim/smelliest-pilgrim/issues](https://github.com/smelliestpilgrim/smelliest-pilgrim/issues).
