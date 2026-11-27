# Smelliest Pilgrim server (Cloudflare Worker + D1)

An optional home for your trail journal: your own destination for the
**Smelliest Pilgrim** watch app ("My server" in Zepp app > Smelliest Pilgrim >
Settings), so your memos reach you over the internet from wherever the phone
has signal. It speaks exactly the Smelliest Pilgrim phone app's protocol
(`/ping`, `/chunk`, `/logpart`, `/commit`) and adds a private memo page where
you can play, download (.ogg) and delete memos, with their time and GPS place.

- Free Cloudflare plan, **no card**: Workers Free (100k requests/day) + D1
  (5 GB, 100k rows written/day). A 50 KB memo is ~5 requests/rows; a whole
  day of memos is a few hundred.
- Every route needs `Authorization: Bearer <TOKEN>`. The memo page asks for the
  token and keeps it in the browser only (optionally remembered).
- Audio is stored exactly as the watch sent it, checked by size + CRC-32, and
  turned into a standard Ogg Opus file **in your browser** (byte-identical to
  what the phone app makes).
- Abandoned half-uploads are cleaned up daily (cron).

## One-time setup (needs your Cloudflare login)

```
cd server
npm install
npx wrangler login                       # opens the browser; free account
npx wrangler d1 create smelliest-pilgrim         # copy the database_id into wrangler.toml
npx wrangler d1 migrations apply smelliest-pilgrim --remote
openssl rand -base64 32 | tr -d '/+=' | cut -c1-40     # make a token
npx wrangler secret put TOKEN            # paste that token
npx wrangler deploy                      # prints https://smelliest-pilgrim.<you>.workers.dev
```

Then in the Zepp app: Profile > T-Rex 3 > App list > Smelliest Pilgrim > Settings:
Destination **My server**, Server URL = the printed address, Token = your
token, **Test connection**. Open the same address in a browser for the memo page.

Reviewer demo (optional, separate database + token, wiped daily): see the
`[env.demo]` notes in `wrangler.toml`.

## Local test (no account)

```
npm install
npm test      # fresh local D1, wrangler dev --local, replays a synthetic day
              # of memos (test/make_day.py; MEMOS=<day folder> for your own) through
              # the watch's own sender + Side Service code, checks the .ogg
              # output byte for byte, then drives the memo page in headless Chrome
```

## Files

- `src/index.js` the Worker (protocol + memo API)
- `migrations/0001_init.sql` D1 schema
- `public/` the memo page (`index.html`, `app.js`, `opus.js` = Zepp-raw to Ogg Opus)
- `test/` `run.sh`, `make_day.py`, `replay.mjs`, `page-check.mjs`

## Privacy

Memos (voice + GPS) are stored in **your** Cloudflare account (a US company),
in the D1 database region Cloudflare picks for you. Only your token opens them.
Use a long random token, change it (`wrangler secret put TOKEN` + the app's settings)
if your phone is lost, and delete memos you have downloaded.
