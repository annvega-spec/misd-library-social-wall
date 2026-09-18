'use strict';

const POLL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_LABEL_MS = 30 * 1000;

const els = {
  status: document.getElementById('status'),
  updated: document.getElementById('updated'),
  loading: document.getElementById('loading'),
  error: document.getElementById('error'),
  errorMsg: document.getElementById('error-msg'),
  empty: document.getElementById('empty'),
  grid: document.getElementById('grid'),
  chipRow: document.getElementById('chip-row'),
  select: document.getElementById('account-select'),
  retry: document.getElementById('retry-btn'),
  demoBanner: document.getElementById('demo-banner'),
};

let allPosts = [];
let accounts = [];
let activeFilter = 'all';
let lastFetchedAt = null;
let pollTimer = null;
let labelTimer = null;

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const sec = Math.round((Date.now() - then) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function formatUpdated(date) {
  if (!date) return '';
  try {
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return date.toISOString();
  }
}

function setView(view) {
  els.loading.hidden = view !== 'loading';
  els.error.hidden = view !== 'error';
  els.empty.hidden = view !== 'empty';
  els.grid.hidden = view !== 'grid';
}

function uniqueUsernames(posts) {
  const set = new Set();
  posts.forEach((p) => set.add(p.username));
  return [...set];
}

function buildFilters(usernames) {
  // Prefer label order from /api/accounts when available
  const ordered = accounts.length
    ? accounts.map((a) => a.username).filter((u) => usernames.includes(u))
    : usernames;

  // Chips (desktop)
  const existing = els.chipRow.querySelectorAll('.chip:not([data-filter="all"])');
  existing.forEach((n) => n.remove());

  ordered.forEach((username) => {
    const label =
      accounts.find((a) => a.username === username)?.label || username;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.filter = username;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.textContent = `@${username}`;
    btn.title = label;
    btn.addEventListener('click', () => setFilter(username));
    els.chipRow.appendChild(btn);
  });

  // Select (mobile)
  els.select.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = 'All accounts';
  els.select.appendChild(allOpt);
  ordered.forEach((username) => {
    const opt = document.createElement('option');
    opt.value = username;
    opt.textContent = `@${username}`;
    els.select.appendChild(opt);
  });
  els.select.value = activeFilter;
}

function setFilter(value) {
  activeFilter = value || 'all';
  els.chipRow.querySelectorAll('.chip').forEach((chip) => {
    const on = chip.dataset.filter === activeFilter;
    chip.classList.toggle('chip--active', on);
    chip.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  els.select.value = activeFilter;
  renderGrid();
}

function mediaHtml(post) {
  const type = (post.media_type || '').toUpperCase();
  const badge =
    type === 'VIDEO'
      ? '<span class="card__badge">Video</span>'
      : type === 'CAROUSEL_ALBUM'
        ? '<span class="card__badge">Album</span>'
        : post.demo
          ? '<span class="card__badge">Demo</span>'
          : '';

  const placeholder = (hidden) => `
        <div class="card__placeholder" style="background:${escapeHtml(post.placeholder_gradient || 'linear-gradient(135deg,#111,#d4af37)')}"${hidden ? ' hidden' : ''}>
          <svg class="card__placeholder-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="5" stroke="#0a0a0a" stroke-width="1.5" opacity="0.7"/>
            <circle cx="12" cy="12" r="4" stroke="#0a0a0a" stroke-width="1.5" opacity="0.7"/>
            <circle cx="17.5" cy="6.5" r="1.2" fill="#0a0a0a" opacity="0.7"/>
          </svg>
          <span class="card__placeholder-handle">@${escapeHtml(post.username)}</span>
        </div>`;

  // Videos: prefer playable <video>; never put an MP4 into <img>
  if (type === 'VIDEO' && post.media_url) {
    const poster = post.thumbnail_url || '';
    return `
      <div class="card__media card__media--video">
        <video controls playsinline preload="metadata" poster="${escapeHtml(poster)}"
               src="${escapeHtml(post.media_url)}"
               onerror="this.style.display='none'; this.nextElementSibling.hidden=false;"></video>
        ${placeholder(true)}
        ${badge}
      </div>`;
  }

  // Image / album / video-without-mp4: use image URL, preferring still for videos
  const src =
    type === 'VIDEO'
      ? post.thumbnail_url || post.media_url
      : post.media_url || post.thumbnail_url;

  if (src) {
    return `
      <div class="card__media">
        <img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async"
             onerror="this.style.display='none'; this.nextElementSibling.hidden=false;" />
        ${placeholder(true)}
        ${badge}
      </div>`;
  }

  const grad =
    post.placeholder_gradient ||
    'linear-gradient(135deg, #1a1408 0%, #d4af37 45%, #0a0a0a 100%)';
  return `
    <div class="card__media">
      <div class="card__placeholder" style="background:${escapeHtml(grad)}">
        <svg class="card__placeholder-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="5" stroke="#0a0a0a" stroke-width="1.5" opacity="0.7"/>
          <circle cx="12" cy="12" r="4" stroke="#0a0a0a" stroke-width="1.5" opacity="0.7"/>
          <circle cx="17.5" cy="6.5" r="1.2" fill="#0a0a0a" opacity="0.7"/>
        </svg>
        <span class="card__placeholder-handle">@${escapeHtml(post.username)}</span>
      </div>
      ${badge}
    </div>`;
}

function renderGrid() {
  const filtered =
    activeFilter === 'all'
      ? allPosts
      : allPosts.filter((p) => p.username === activeFilter);

  if (!filtered.length) {
    setView('empty');
    els.status.textContent =
      activeFilter === 'all' ? 'No posts' : `No posts for @${activeFilter}`;
    return;
  }

  els.grid.innerHTML = filtered
    .map((post) => {
      const caption = (post.caption || '').trim() || 'View on Instagram';
      const href = post.permalink || `https://www.instagram.com/${post.username}/`;
      return `
        <a class="card" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"
           aria-label="Instagram post by @${escapeHtml(post.username)}">
          ${mediaHtml(post)}
          <div class="card__body">
            <p class="card__user">@${escapeHtml(post.username)}</p>
            <p class="card__caption">${escapeHtml(caption)}</p>
            <p class="card__time">${escapeHtml(relativeTime(post.timestamp))}</p>
          </div>
        </a>`;
    })
    .join('');

  setView('grid');
  els.status.textContent =
    activeFilter === 'all'
      ? `${filtered.length} posts · ${uniqueUsernames(allPosts).length} libraries`
      : `@${activeFilter} · ${filtered.length} posts`;
}

function updateTimestampLabel() {
  if (!lastFetchedAt) {
    els.updated.hidden = true;
    return;
  }
  els.updated.hidden = false;
  els.updated.textContent = `Updated ${formatUpdated(lastFetchedAt)}`;
}

async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts');
    if (!res.ok) return;
    const data = await res.json();
    accounts = data.accounts || [];
  } catch {
    /* optional */
  }
}

async function loadFeed({ silent } = {}) {
  if (!silent) {
    setView('loading');
    els.status.textContent = 'Loading…';
  }

  try {
    const res = await fetch('/api/feed', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allPosts = Array.isArray(data.posts) ? data.posts : [];
    lastFetchedAt = new Date();

    const usernames =
      Array.isArray(data.accounts) && data.accounts.length
        ? data.accounts
        : uniqueUsernames(allPosts);
    buildFilters(usernames);

    els.demoBanner.hidden = !(data.demo || data.source === 'demo' || data.source === 'demo_fallback');

    if (data.error && allPosts.length) {
      els.status.textContent = 'Showing fallback feed';
    }

    updateTimestampLabel();
    renderGrid();
  } catch (err) {
    console.error(err);
    if (!silent || !allPosts.length) {
      setView('error');
      els.errorMsg.textContent = err.message || 'Could not load the social wall.';
      els.status.textContent = 'Error';
    }
  }
}

function startPolling() {
  clearInterval(pollTimer);
  clearInterval(labelTimer);
  pollTimer = setInterval(() => loadFeed({ silent: true }), POLL_MS);
  labelTimer = setInterval(updateTimestampLabel, REFRESH_LABEL_MS);
}

els.chipRow.querySelector('[data-filter="all"]').addEventListener('click', () => setFilter('all'));
els.select.addEventListener('change', (e) => setFilter(e.target.value));
els.retry.addEventListener('click', () => loadFeed());

(async function init() {
  await loadAccounts();
  await loadFeed();
  startPolling();
})();
