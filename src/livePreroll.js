// Video pre-roll in front of a live OpenPods stream (`?live=` embeds).
//
// The same spot the 3speak.tv stream pages play: the checker's live surface
// (`POST /m/session`, surface 'live', `preroll: true`) hands back a roll booked
// at 0% or 50% under every usual rule (approval, Pro viewers, the creator's
// opt-out, cooldown, frequency caps, markets). It is never spliced into the
// stream: it plays from its own playlist (/m/:sid/short.m3u8) on the player's
// <video> BEFORE the LiveKit connection is made, so nothing of the stream is
// seen or heard underneath it.
//
// Fails OPEN everywhere: no answer within ASK_TIMEOUT_MS, no spot, a playlist
// that will not load, a refused autoplay that cannot even start muted, a stall,
// a player error: the stream simply starts. Only seconds that really played are
// reported (POST /m/:sid/w, credited by the checker against its own clock); a
// skip is reported as one (POST /m/:sid/skipped).
//
// Self-contained DOM with inline styles, like the rest of the live path: the
// embed's ad styles are scoped to Video.js, which the live path never starts.

import Hls from 'hls.js';
import { AD_BASE, CAP_ID, recentAdKeys, rememberAdSeen } from './adBreak.js';

const ASK_TIMEOUT_MS = 3000;
const STALL_MS = 12000;
const BEAT_S = 2;

function el(tag, styles, text) {
  const node = document.createElement(tag);
  if (styles) Object.assign(node.style, styles);
  if (text != null) node.textContent = text;
  return node;
}

async function askForPreroll({ host, room }) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), ASK_TIMEOUT_MS);
  try {
    const res = await fetch(`${AD_BASE}/m/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl?.signal,
      body: JSON.stringify({
        surface: 'live',
        owner: host,
        permlink: room,
        viewer: null,
        capId: CAP_ID,
        recentAdKeys: recentAdKeys(),
        preroll: true,
        // This player draws neither a ticker nor a banner over a live stream.
        ticker: false,
        bannerOverlay: true,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ad = data && data.ad;
    if (!ad || !ad.preroll || !ad.manifestUrl) return null;
    const sid = (String(ad.manifestUrl).match(/\/m\/([0-9a-f]{32})\//) || [])[1] || null;
    return sid ? { ...ad, sid } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Play a pre-roll for this stream if the checker has one. Resolves when the
 * stream may start (always: after the spot, a skip, or any failure), and
 * leaves `video` as it found it: muted, no source.
 */
export async function playLivePreroll({ wrapper, video, host, room }) {
  if (!wrapper || !video || !host || !room) return;
  const ad = await askForPreroll({ host, room });
  if (!ad) return;

  const total = Number(ad.durationSeconds) || 0;
  const skipAfter = typeof ad.skipAfterSeconds === 'number' ? ad.skipAfterSeconds : null;
  const brand = ad.brand || {};

  // --- chrome -----------------------------------------------------------------
  const layer = el('div', {
    position: 'absolute', inset: '0', zIndex: 7, pointerEvents: 'none',
    fontFamily: 'system-ui, sans-serif', color: '#fff',
  });
  const cover = el('div', {
    position: 'absolute', inset: '0', background: '#000',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '14px', color: '#bbb',
  }, 'Loading…');
  const disclosure = el('div', {
    position: 'absolute', top: '12px', left: '12px', maxWidth: 'min(260px, calc(100% - 24px))',
    display: 'flex', flexDirection: 'column', gap: '3px',
    padding: '7px 11px', borderRadius: '10px', background: 'rgba(0,0,0,0.62)',
    fontSize: '12px', lineHeight: '1.3', pointerEvents: 'auto',
  });
  const from = el('span', { opacity: '0.85' }, brand.account ? `Advertisement from @${brand.account}` : 'Advertisement');
  disclosure.appendChild(from);
  if (brand.productName) {
    const name = brand.clickUrl ? el('a') : el('strong');
    name.textContent = brand.productName;
    Object.assign(name.style, { color: '#fff', fontWeight: '700', fontSize: '13px', textDecoration: 'none' });
    if (brand.clickUrl) {
      name.href = brand.clickUrl;
      name.target = '_blank';
      name.rel = 'noopener noreferrer sponsored';
      name.textContent = `${brand.productName} ↗`;
    }
    disclosure.appendChild(name);
  }
  if (brand.slogan) disclosure.appendChild(el('span', { opacity: '0.85' }, brand.slogan));
  const resume = el('span', { marginTop: '2px', fontWeight: '600' });
  disclosure.appendChild(resume);

  const pill = {
    position: 'absolute', bottom: '14px', zIndex: 1, display: 'none', alignItems: 'center', gap: '6px',
    padding: '7px 13px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.35)',
    background: 'rgba(0,0,0,0.66)', color: '#fff', fontSize: '13px', fontWeight: '600',
    fontFamily: 'system-ui, sans-serif', pointerEvents: 'auto', cursor: 'pointer',
  };
  const skip = el('button', { ...pill, right: '12px' });
  skip.type = 'button';
  const sound = el('button', { ...pill, left: '12px' }, '🔊 Tap for sound');
  sound.type = 'button';

  layer.appendChild(cover);
  layer.appendChild(disclosure);
  layer.appendChild(skip);
  layer.appendChild(sound);
  wrapper.appendChild(layer);

  // --- playback -----------------------------------------------------------------
  let hls = null;
  let played = 0;
  let reported = 0;
  let remembered = false;
  const report = () => {
    const secs = Math.round(played * 100) / 100;
    if (secs <= reported) return;
    reported = secs;
    fetch(`${AD_BASE}/m/${ad.sid}/w`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: secs }), keepalive: true,
    }).catch(() => { /* an unreported beat is not a failure */ });
  };

  await new Promise((resolve) => {
    let done = false;
    let lastProgress = Date.now();
    const finish = (how) => {
      if (done) return;
      done = true;
      clearInterval(watchdog);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.removeEventListener('playing', onPlaying);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onLeave);
      report();
      if (how === 'skipped') {
        fetch(`${AD_BASE}/m/${ad.sid}/skipped`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true,
        }).catch(() => { /* the viewer is through either way */ });
      }
      try { hls?.destroy(); } catch { /* already gone */ }
      try { video.pause(); } catch { /* nothing to pause */ }
      video.removeAttribute('src');
      try { video.load(); } catch { /* reset best effort */ }
      video.muted = true;
      layer.remove();
      resolve();
    };

    const render = () => {
      const pos = video.currentTime || 0;
      const left = total > 0 ? Math.max(0, Math.ceil(total - pos)) : null;
      resume.textContent = left == null ? '' : (left > 0 ? `The stream starts in ${left}s` : 'The stream starts in a moment');
      if (skipAfter == null) return;
      skip.style.display = 'inline-flex';
      const until = skipAfter - pos;
      const ready = until <= 0;
      skip.textContent = ready ? 'Skip ad ⏭' : `Skip in ${Math.max(1, Math.ceil(until))}`;
      skip.style.cursor = ready ? 'pointer' : 'default';
      skip.style.opacity = ready ? '1' : '0.85';
      skip.dataset.ready = ready ? '1' : '0';
    };
    const onTime = () => {
      lastProgress = Date.now();
      const pos = video.currentTime || 0;
      if (pos > played) played = pos;
      if (!remembered && pos > 0) { remembered = true; if (ad.adKey) rememberAdSeen(ad.adKey); }
      if (played - reported >= BEAT_S) report();
      render();
    };
    const onPlaying = () => { cover.style.display = 'none'; render(); };
    const onEnded = () => { played = Math.max(played, total); finish('ended'); };
    const onError = () => finish('failed');
    // Paused while the tab is hidden; a viewer who clicked through does not miss the rest.
    const onVisibility = () => {
      if (document.hidden) { try { video.pause(); } catch { /* fine */ } }
      else video.play().catch(() => { /* they can tap */ });
    };
    const onLeave = () => report();

    skip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (skip.dataset.ready === '1') finish('skipped');
    });
    sound.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      video.muted = false;
      video.play().catch(() => { /* still playing muted */ });
      sound.style.display = 'none';
    });

    video.addEventListener('timeupdate', onTime);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('playing', onPlaying);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onLeave);

    // Measures progress, not wall clock; hidden or paused time does not count.
    const watchdog = setInterval(() => {
      if (document.hidden || video.paused) { lastProgress = Date.now(); return; }
      if (Date.now() - lastProgress > STALL_MS) finish('failed');
    }, 1000);

    // With sound when the browser lets us, else muted with a button, else not at all.
    const start = async () => {
      try {
        video.muted = false;
        await video.play();
      } catch {
        try {
          video.muted = true;
          await video.play();
          sound.style.display = 'inline-flex';
        } catch {
          finish('failed');
        }
      }
    };

    video.loop = false;
    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: true });
      hls.on(Hls.Events.ERROR, (_e, data) => { if (data && data.fatal) finish('failed'); });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { start(); });
      hls.loadSource(ad.manifestUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = ad.manifestUrl;
      start();
    } else {
      finish('failed');
    }
  });
}
