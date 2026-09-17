'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const PORT = Number(process.env.PORT) || 3000;
const IG_USER_ID = process.env.IG_USER_ID || '';
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || '';
const BEHOLD_FEED_URL = process.env.BEHOLD_FEED_URL || '';
const GRAPH_VERSION = 'v21.0';
const MEDIA_LIMIT = 6;
const CACHE_SECONDS = 900; // 15 min server cache

const accountsPath = path.join(__dirname, 'data', 'accounts.json');
const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

/** Gold/black CSS gradient placeholders — never fake IG CDN URLs */
const DEMO_GRADIENTS = [
  'linear-gradient(135deg, #1a1408 0%, #d4af37 45%, #0a0a0a 100%)',
  'linear-gradient(160deg, #0a0a0a 0%, #c9a227 50%, #1a1a1a 100%)',
  'linear-gradient(120deg, #111 0%, #b8860b 40%, #d4af37 70%, #0a0a0a 100%)',
  'linear-gradient(200deg, #1c1608 0%, #8b7355 35%, #d4af37 65%, #111 100%)',
  'linear-gradient(145deg, #0a0a0a 10%, #d4af37 55%, #c9a227 80%, #111 100%)',
  'linear-gradient(180deg, #111111 0%, #3d3318 40%, #d4af37 90%)',
];

const DEMO_CAPTIONS = [
  'New arrivals are here! Stop by the library this week 📚✨',
  'Reading challenge kickoff — join us and earn your gold bookmark!',
  'Maker Monday: craft, create, and check out something new.',
  'Staff pick of the week is flying off the shelves 🐆',
  'Quiet corner vibes + great stories. See you after lunch!',
  'Thank you for celebrating literacy with us — go Jaguars!',
];

function buildDemoFeed() {
  const now = Date.now();
  const posts = [];
  accounts.forEach((acct, ai) => {
    const count = 2 + (ai % 3); // 2–4 posts per account
    for (let i = 0; i < count; i++) {
      const hoursAgo = ai * 3 + i * 7 + (ai % 5);
      const ts = new Date(now - hoursAgo * 3600 * 1000).toISOString();
      const g = DEMO_GRADIENTS[(ai + i) % DEMO_GRADIENTS.length];
      const caption = DEMO_CAPTIONS[(ai + i) % DEMO_CAPTIONS.length];
      posts.push({
        id: `demo-${acct.username}-${i}`,
        username: acct.username,
        label: acct.label || acct.username,
        caption,
        media_type: 'IMAGE',
        media_url: null,
        thumbnail_url: null,
        placeholder_gradient: g,
        permalink: `https://www.instagram.com/${acct.username}/`,
        timestamp: ts,
        demo: true,
      });
    }
  });
  posts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return {
    source: 'demo',
    demo: true,
    generated_at: new Date().toISOString(),
    accounts: accounts.map((a) => a.username),
    posts,
  };
}

function normalizeGraphMedia(media, username, label) {
  if (!media || !Array.isArray(media.data)) return [];
  return media.data.map((m) => ({
    id: m.id,
    username: m.username || username,
    label: label || username,
    caption: m.caption || '',
    media_type: m.media_type || 'IMAGE',
    media_url: m.media_url || null,
    thumbnail_url: m.thumbnail_url || null,
    placeholder_gradient: null,
    permalink: m.permalink || `https://www.instagram.com/${username}/`,
    timestamp: m.timestamp,
    demo: false,
  }));
}

async function fetchBusinessDiscovery(username, label) {
  const fields = `business_discovery.username(${username}){media.limit(${MEDIA_LIMIT}){id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,username}}`;
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(IG_USER_ID)}` +
    `?fields=${encodeURIComponent(fields)}` +
    `&access_token=${encodeURIComponent(IG_ACCESS_TOKEN)}`;

  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || res.statusText || 'Graph API error';
    throw new Error(`${username}: ${msg}`);
  }
  const bd = body.business_discovery;
  if (!bd || !bd.media) {
    throw new Error(`${username}: no media (private, personal, or not discoverable)`);
  }
  return normalizeGraphMedia(bd.media, username, label);
}

let feedCache = null; // { expiresAt, data }
let feedInflight = null;
let lastGoodFeed = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLiveFeed() {
  // Sequential + small delay to avoid Meta (#4) application rate limits.
  const posts = [];
  const errors = [];
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    try {
      const items = await fetchBusinessDiscovery(a.username, a.label);
      posts.push(...items);
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn('[feed] skip', a.username, msg);
      errors.push({ username: a.username, error: msg });
    }
    if (i < accounts.length - 1) await sleep(350);
  }
  posts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return {
    source: 'instagram_graph',
    demo: false,
    generated_at: new Date().toISOString(),
    accounts: accounts.map((a) => a.username),
    errors,
    posts,
  };
}

async function getCachedLiveFeed() {
  const now = Date.now();
  if (feedCache && feedCache.expiresAt > now) {
    return feedCache.data;
  }
  if (feedInflight) return feedInflight;

  feedInflight = (async () => {
    try {
      const feed = await fetchLiveFeed();
      const rateLimited =
        Array.isArray(feed.errors) &&
        feed.errors.some((e) => /request limit reached/i.test(e.error || ''));

      // If Meta rate-limits us and we got zero posts, keep serving the last good feed.
      if (feed.posts.length === 0 && rateLimited && lastGoodFeed?.posts?.length) {
        const stale = {
          ...lastGoodFeed,
          generated_at: new Date().toISOString(),
          stale: true,
          errors: feed.errors,
        };
        feedCache = { expiresAt: now + CACHE_SECONDS * 1000, data: stale };
        return stale;
      }

      if (feed.posts.length > 0) lastGoodFeed = feed;
      feedCache = { expiresAt: now + CACHE_SECONDS * 1000, data: feed };
      return feed;
    } finally {
      feedInflight = null;
    }
  })();

  return feedInflight;
}

function normalizeBeholdItem(item) {
  const username =
    item.username ||
    item.account ||
    item.ownerUsername ||
    (item.permalink && String(item.permalink).match(/instagram\.com\/([^/]+)/)?.[1]) ||
    'unknown';
  const mediaUrl =
    item.mediaUrl || item.media_url || item.url || item.thumbnailUrl || item.thumbnail_url || null;
  return {
    id: String(item.id || item.mediaId || `${username}-${item.timestamp || Date.now()}`),
    username,
    label: item.label || username,
    caption: item.caption || item.text || '',
    media_type: item.mediaType || item.media_type || 'IMAGE',
    media_url: mediaUrl,
    thumbnail_url: item.thumbnailUrl || item.thumbnail_url || null,
    placeholder_gradient: null,
    permalink: item.permalink || item.permalinkUrl || `https://www.instagram.com/${username}/`,
    timestamp: item.timestamp || item.takenAt || item.createdAt || new Date().toISOString(),
    demo: false,
  };
}

async function fetchBeholdFeed() {
  const res = await fetch(BEHOLD_FEED_URL);
  if (!res.ok) throw new Error(`Behold feed HTTP ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data) ? data : data.posts || data.media || data.items || [];
  const posts = raw.map(normalizeBeholdItem);
  posts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return {
    source: 'behold',
    demo: false,
    generated_at: new Date().toISOString(),
    accounts: accounts.map((a) => a.username),
    posts,
  };
}

app.get('/api/accounts', (_req, res) => {
  res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  res.json({ accounts });
});

app.get('/api/feed', async (_req, res) => {
  res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  try {
    if (IG_USER_ID && IG_ACCESS_TOKEN) {
      const feed = await getCachedLiveFeed();
      return res.json(feed);
    }
    if (BEHOLD_FEED_URL) {
      const feed = await fetchBeholdFeed();
      return res.json(feed);
    }
    return res.json(buildDemoFeed());
  } catch (err) {
    console.error('[feed] fatal', err);
    // Fall back to demo so the wall is never blank
    const demo = buildDemoFeed();
    demo.source = 'demo_fallback';
    demo.error = err.message || 'Feed unavailable';
    return res.json(demo);
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode:
      IG_USER_ID && IG_ACCESS_TOKEN
        ? 'instagram_graph'
        : BEHOLD_FEED_URL
          ? 'behold'
          : 'demo',
    accounts: accounts.length,
  });
});

// SPA-ish: unknown routes → index (keeps iframe embeds simple)
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  const mode =
    IG_USER_ID && IG_ACCESS_TOKEN
      ? 'Instagram Graph (Business Discovery)'
      : BEHOLD_FEED_URL
        ? 'Behold feed'
        : 'DEMO (set IG_USER_ID + IG_ACCESS_TOKEN or BEHOLD_FEED_URL for live)';
  console.log(`McAllen ISD Library Social Wall → http://localhost:${PORT}`);
  console.log(`Mode: ${mode}`);
  console.log(`Accounts: ${accounts.length}`);
});
