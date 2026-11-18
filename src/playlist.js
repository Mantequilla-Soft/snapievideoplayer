/**
 * Playlist mode: play.3speak.tv/watch?v=<owner>/<playlist id> for a playlist of videos
 * (and the audio in it: those items play through playlistAudio.js).
 *
 * Loaded only for a playlist (main.js imports it when /api/watch answers
 * `videoPlaylist`), so a single video never downloads it. The videos come from
 * GET /api/playlist (videoPlaylist.js on the server) and play one after another in
 * the SAME player: main.js playPlaylistItem() swaps the source and starts the
 * per-video bookkeeping (view, watch session, sponsor break) afresh. Swapping in
 * place, not navigating, keeps the next video playing with sound: browsers (iOS
 * above all) block unmuted autoplay on a freshly loaded page.
 *
 * UI:
 *  - Previous and next after the play button, a list button before fullscreen.
 *  - The list: cards (thumbnail with its duration, a short title under it) under a
 *    head with the name, the position and a close button. It opens DOCKED on the
 *    right, beside the player: a sibling of the Video.js element in .player-wrapper,
 *    so Video.js only sees a narrower player and its overlays stay where they were.
 *    In an embed the player then fills the frame's height instead of shrinking with
 *    its width. Closed with its x, opened again with the list button.
 *  - It starts open wherever it docks. Where docking would leave too little video
 *    (fullscreen, a fixed app layout, a frame narrower than DOCK_MIN_WIDTH), the same
 *    list lies OVER the right side of the video instead, and starts closed.
 */

// Docked from this frame width up (Ecency, Waves and Snapie embeds included); the
// list then takes 20% of it, 112 to 195px, and the video shrinks to its left.
const DOCK_MIN_WIDTH = 320;
// App layouts with a fixed shape. layout-fill (an embed's default) docks fine.
const FIXED_LAYOUTS = ['layout-mobile', 'layout-square', 'layout-desktop'];

const ICONS = {
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
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

function button(cls, label, icon) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = icon;
  return b;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * Adds the playlist controls and list to `player` and plays the videos in order.
 * `playItem(item)` loads and plays one video (main.js playPlaylistItem); it throws
 * when the video does not load, and the playlist then moves on to the one after.
 */
export function mountPlaylist(player, list, playItem) {
  const n = list.items.length;
  const bar = player.controlBar.el();
  const btn = (cls, label, icon) => button(`vjs-control vjs-button vjs-playlist-btn ${cls}`, label, icon);
  const prev = btn('vjs-playlist-prev', 'Previous', ICONS.prev);
  const next = btn('vjs-playlist-next', 'Next', ICONS.next);
  const toggle = btn('vjs-playlist-toggle', 'Playlist', ICONS.list);

  // The list: head (name, position, close) and one card per video.
  const dock = el('aside', 'vjs-playlist-dock');
  dock.setAttribute('aria-label', 'Playlist');
  const head = el('div', 'vjs-playlist-head');
  const name = el('span', 'vjs-playlist-name', list.name || 'Playlist');
  const pos = el('span', 'vjs-playlist-pos');
  const close = button('vjs-playlist-close', 'Close playlist', ICONS.close);
  head.append(name, pos, close);
  const ol = el('ol', 'vjs-playlist-items');
  const cards = list.items.map((item, i) => {
    const card = el('button', 'vjs-playlist-card');
    card.type = 'button';
    const thumb = el('span', 'vjs-playlist-thumb');
    if (item.thumbnail) thumb.style.backgroundImage = `url("${String(item.thumbnail).replace(/"/g, '%22')}")`;
    const dur = formatDuration(item.duration);
    if (dur) thumb.appendChild(el('span', 'vjs-playlist-dur', dur));
    // An audio (a mixed playlist): a headphones mark on its cover.
    if (item.kind === 'audio') {
      card.classList.add('is-audio');
      const mark = el('span', 'vjs-playlist-kind');
      mark.innerHTML = ICONS.audio;
      mark.title = 'Audio';
      thumb.appendChild(mark);
    }
    card.append(thumb, el('span', 'vjs-playlist-title', item.title));
    card.addEventListener('click', () => {
      go(i);
      // Over the video, a pick closes the list so the video shows; docked, it stays.
      if (dock.classList.contains('is-overlay')) setOpen(false);
    });
    const li = document.createElement('li');
    li.appendChild(card);
    ol.appendChild(li);
    return card;
  });
  const scroller = el('div', 'vjs-playlist-scroll');
  scroller.appendChild(ol);
  dock.append(head, scroller);

  // Clicks on our controls must not reach Video.js, or they toggle play/pause.
  for (const e of [prev, next, toggle, dock]) e.addEventListener('click', (ev) => ev.stopPropagation());

  const play = bar.querySelector('.vjs-play-control');
  if (play) play.after(prev, next);
  else bar.prepend(prev, next);
  const fs = bar.querySelector('.vjs-fullscreen-control');
  if (fs) bar.insertBefore(toggle, fs);
  else bar.appendChild(toggle);

  const playerEl = player.el();
  const wrapper = playerEl.parentElement;
  const wasFluid = typeof player.fluid === 'function' ? !!player.fluid() : false;
  const embedded = document.body.classList.contains('iframe-mode') || document.documentElement.classList.contains('iframe-mode');
  const canDock = () => !player.isFullscreen()
    && !FIXED_LAYOUTS.some((c) => document.body.classList.contains(c))
    && !!wrapper && wrapper.clientWidth >= DOCK_MIN_WIDTH;

  let open = canDock();
  let docked = null; // where the list sits now: true beside, false over the video

  // Put the list beside the player or over the video, and size the player to match.
  function place() {
    const dock2 = open && canDock();
    if (dock2 !== docked) {
      docked = dock2;
      dock.classList.toggle('is-overlay', !docked);
      if (docked) wrapper.appendChild(dock);
      else playerEl.appendChild(dock);
      wrapper?.classList.toggle('has-playlist-dock', docked);
      // In an embed the frame is the box: the player fills its height beside the
      // list rather than shrinking with its width. Back to fluid once undocked.
      if (embedded && wasFluid) {
        if (docked) { player.fluid(false); player.fill(true); } else { player.fill(false); player.fluid(true); }
      }
    }
    dock.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }

  function setOpen(o) {
    open = o;
    place();
    if (open) cards[list.index]?.scrollIntoView({ block: 'nearest' });
  }

  function render() {
    pos.textContent = `${list.index + 1} / ${n}`;
    prev.disabled = list.index <= 0;
    next.disabled = list.index >= n - 1;
    cards.forEach((c, i) => {
      c.classList.toggle('is-current', i === list.index);
      if (i === list.index) c.setAttribute('aria-current', 'true');
      else c.removeAttribute('aria-current');
    });
    if (open) cards[list.index]?.scrollIntoView({ block: 'nearest' });
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
  toggle.addEventListener('click', () => setOpen(!open));
  close.addEventListener('click', () => setOpen(false));
  player.on('ended', () => { if (list.index < n - 1) go(list.index + 1); });
  player.on('fullscreenchange', place);
  window.addEventListener('resize', place);

  place();
  render();
  return { go, render, setOpen };
}
