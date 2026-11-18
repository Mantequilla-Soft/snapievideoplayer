/**
 * Playlist mode: play.3speak.tv/watch?v=<owner>/<playlist id> for a playlist of videos.
 *
 * Loaded only for a playlist (main.js imports it when /api/watch answers
 * `videoPlaylist`), so a single video never downloads it. The videos come from
 * GET /api/playlist (videoPlaylist.js on the server) and play one after another in
 * the SAME player: main.js playPlaylistItem() swaps the source and starts the
 * per-video bookkeeping (view, watch session, sponsor break) afresh. Swapping in
 * place, not navigating, keeps the next video playing with sound: browsers (iOS
 * above all) block unmuted autoplay on a freshly loaded page.
 *
 * UI, in the control bar so it hides with it and works in fullscreen: previous and
 * next after the play button, and a list button (name, position, every video)
 * before the fullscreen button. The top corners belong to the sponsor overlays.
 */

const ICONS = {
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>',
};

/** The playlist for `ref` ("owner/id") with `index` 0, or null when it has no videos. */
export async function loadPlaylist(ref) {
  try {
    const [owner, id] = String(ref).split('/');
    const r = await fetch(`/api/playlist?v=${encodeURIComponent(owner)}/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    const data = await r.json();
    return data && Array.isArray(data.items) && data.items.length ? { ...data, index: 0 } : null;
  } catch {
    return null;
  }
}

function formatDuration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function controlButton(cls, label, icon) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `vjs-control vjs-button vjs-playlist-btn ${cls}`;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = icon;
  return b;
}

/**
 * Adds the playlist controls to `player` and plays the videos in order.
 * `playItem(item)` loads and plays one video (main.js playPlaylistItem); it throws
 * when the video does not load, and the playlist then moves on to the one after.
 */
export function mountPlaylist(player, list, playItem) {
  const n = list.items.length;
  const bar = player.controlBar.el();
  const prev = controlButton('vjs-playlist-prev', 'Previous video', ICONS.prev);
  const next = controlButton('vjs-playlist-next', 'Next video', ICONS.next);
  const toggle = controlButton('vjs-playlist-toggle', 'Playlist', ICONS.list);
  toggle.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'vjs-playlist-panel';
  panel.hidden = true;
  const head = document.createElement('div');
  head.className = 'vjs-playlist-head';
  const name = document.createElement('span');
  name.className = 'vjs-playlist-name';
  name.textContent = list.name || 'Playlist';
  const pos = document.createElement('span');
  pos.className = 'vjs-playlist-pos';
  head.append(name, pos);
  const ol = document.createElement('ol');
  ol.className = 'vjs-playlist-items';
  const rows = list.items.map((item, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vjs-playlist-item';
    const thumb = document.createElement('span');
    thumb.className = 'vjs-playlist-thumb';
    if (item.thumbnail) thumb.style.backgroundImage = `url("${String(item.thumbnail).replace(/"/g, '%22')}")`;
    const title = document.createElement('span');
    title.className = 'vjs-playlist-title';
    title.textContent = item.title;
    const dur = document.createElement('span');
    dur.className = 'vjs-playlist-dur';
    dur.textContent = formatDuration(item.duration);
    b.append(thumb, title, dur);
    b.addEventListener('click', () => { go(i); setOpen(false); });
    li.appendChild(b);
    ol.appendChild(li);
    return b;
  });
  panel.append(head, ol);

  // Clicks on our controls must not reach Video.js, or they toggle play/pause.
  for (const el of [prev, next, toggle, panel]) el.addEventListener('click', (e) => e.stopPropagation());

  const play = bar.querySelector('.vjs-play-control');
  if (play) play.after(prev, next);
  else bar.prepend(prev, next);
  const fs = bar.querySelector('.vjs-fullscreen-control');
  if (fs) bar.insertBefore(toggle, fs);
  else bar.appendChild(toggle);
  player.el().appendChild(panel);

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) rows[list.index]?.scrollIntoView({ block: 'nearest' });
  }

  function render() {
    pos.textContent = `${list.index + 1} / ${n}`;
    prev.disabled = list.index <= 0;
    next.disabled = list.index >= n - 1;
    rows.forEach((b, i) => {
      b.classList.toggle('is-current', i === list.index);
      if (i === list.index) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
  }

  let busy = false;
  async function go(i, step = 1) {
    if (busy || i < 0 || i >= n || i === list.index) return;
    busy = true;
    try {
      await playItem(list.items[i]);
      list.index = i;
      render();
    } catch {
      // That one does not load (deleted since the list was cached): skip it.
      busy = false;
      if (i + step >= 0 && i + step < n) return go(i + step, step);
    }
    busy = false;
  }

  prev.addEventListener('click', () => go(list.index - 1, -1));
  next.addEventListener('click', () => go(list.index + 1));
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  player.on('ended', () => { if (list.index < n - 1) go(list.index + 1); });

  render();
  return { go, render };
}
