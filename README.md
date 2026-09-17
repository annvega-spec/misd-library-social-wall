# McAllen ISD Libraries — Instagram Social Wall

Black & gold embeddable web app that shows the latest Instagram posts from McAllen ISD library accounts. Designed for **Thrillshare** iframes and school websites.

## Quick start

```bash
cd misd-library-social-wall
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

With no Instagram credentials configured, the app runs in **demo mode** (gradient placeholders, real account handles, profile links) so the wall is never blank.

### Dev (auto-restart)

```bash
npm run dev
```

## Environment

Copy `.env.example` to `.env` and fill in as needed:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `IG_USER_ID` | Instagram Business/Creator user ID used for Business Discovery |
| `IG_ACCESS_TOKEN` | Long-lived access token with Graph permissions |
| `BEHOLD_FEED_URL` | Optional alternative JSON feed (e.g. Behold.so) |

Priority: **Instagram Graph** → **Behold** → **demo**.

## How Meta Business Discovery works

Instagram’s official Graph API lets **one** professional Instagram account discover public media from **other** professional (Business/Creator) accounts — without scraping.

District needs:

1. **One** Instagram Business or Creator account (can be a central / district library account).
2. A Facebook Page linked to that Instagram account.
3. A Meta app (developers.facebook.com) with Instagram Graph API access.
4. A long-lived User or Page token with permissions such as:
   - `instagram_basic`
   - `pages_read_engagement`
   - (and Business Discovery access as required by Meta’s current docs)

Then set:

```env
IG_USER_ID=<that account’s Instagram user id>
IG_ACCESS_TOKEN=<long-lived token>
```

The server calls (per username):

```
GET https://graph.facebook.com/v21.0/{IG_USER_ID}
  ?fields=business_discovery.username({username}){media.limit(6){id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,username}}
  &access_token=...
```

Accounts that are private, personal (not professional), or otherwise undiscoverable are **skipped and logged**; the wall still shows the rest.

> **Note:** Only professional Instagram accounts are discoverable. Personal accounts will fail Business Discovery — convert them to Business/Creator or use a curated feed service (Behold).

## Optional Behold feed

If you already aggregate Instagram via [Behold](https://behold.so) (or a similar JSON feed), set `BEHOLD_FEED_URL` to that JSON endpoint. The server normalizes common field names into the wall’s post shape.

## API

| Endpoint | Description |
|---|---|
| `GET /api/feed` | Merged posts, newest first. `Cache-Control: max-age=600` |
| `GET /api/accounts` | Account list from `data/accounts.json` |
| `GET /api/health` | Mode + account count |

Frontend polls `/api/feed` every **10 minutes** and shows an “Updated …” timestamp.

## Accounts

Configured in `data/accounts.json` (17 library handles). Add or edit labels there.

## Thrillshare embed

Paste into Thrillshare’s custom HTML / section editor. **HTTPS is required.**

```html
<iframe
  src="https://YOUR-HOSTED-URL/"
  title="McAllen ISD Library Social Wall"
  width="100%"
  height="900"
  style="border:0;border-radius:8px;background:#0a0a0a;"
  loading="lazy"
></iframe>
```

Tips:

- Default height ~900–1000px works well; adjust per page layout.
- The UI avoids horizontal overflow so it behaves inside iframes.
- Theme matches McAllen ISD black & gold (`#0a0a0a` / `#d4af37`).

## Hosting notes

Because the app needs a small **Node** API (`/api/feed`), do **not** use GitHub Pages alone for production.

Good fits:

- **Railway** / **Render** / **Fly.io** — deploy Node, set env vars in the dashboard
- **Vercel** — possible with a serverless/Express adapter; ensure `/api/feed` stays server-side
- **School Node host** — `npm install && npm start` behind HTTPS reverse proxy

Remember:

- Never commit `.env` or tokens
- Rotate Meta tokens before they expire
- Allowlist your domain in Meta app settings if required

## Design

- Background `#0a0a0a` / `#111`, gold `#d4af37` / `#c9a227`, cream text
- Header: “McAllen ISD Libraries” + “Social Wall” with gold accent
- Responsive card grid, filter chips (select on mobile)
- Loading / empty / error states on-brand
- Accessible focus rings and skip link

## License

Private / UNLICENSED — for McAllen ISD use.
