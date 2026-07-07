import Hls from 'hls.js';

/**
 * YouTube-style scrub preview for the video.js seek bar.
 *
 * Mirrors the technique used on the preview-3speak watch page: a *detached*
 * <video> loads the SAME HLS manifest but is pinned to the LOWEST rendition
 * (via hls.js) so seeking is cheap, and we render its frame in a small
 * thumbnail above the seek bar as the user hovers (desktop) or drags (touch).
 *
 * It never touches the main player — the preview media is completely separate,
 * so scrubbing the preview can't disturb playback.
 *
 * @param {import('video.js').Player} player  the main video.js player
 * @returns {{ setSource(url:string):void, destroy():void }}
 */
export function createScrubPreview(player) {
  const playerEl = player.el();

  // ── Thumbnail DOM (positioned above the seek bar; centred on the cursor) ──
  const wrap = document.createElement('div');
  wrap.className = 'scrub-preview';
  const vid = document.createElement('video');
  vid.className = 'scrub-preview-video';
  vid.muted = true;
  vid.defaultMuted = true;
  vid.playsInline = true;
  vid.preload = 'auto';
  vid.setAttribute('muted', '');
  vid.setAttribute('playsinline', '');
  const timeEl = document.createElement('div');
  timeEl.className = 'scrub-preview-time';
  wrap.appendChild(vid);
  wrap.appendChild(timeEl);
  playerEl.appendChild(wrap);

  let hls = null;
  let currentUrl = null;
  let pendingTime = null; // a seek requested while the preview was already seeking
  let lastSeek = -1;

  function teardownHls() {
    if (hls) { try { hls.destroy(); } catch { /* noop */ } hls = null; }
    pendingTime = null;
    lastSeek = -1;
  }

  // Point the preview at a manifest and pin it to the lowest rendition.
  function setSource(url) {
    if (!url || url === currentUrl) return;
    currentUrl = url;
    teardownHls();
    try { vid.removeAttribute('src'); vid.load(); } catch { /* noop */ }

    if (Hls.isSupported()) {
      hls = new Hls({
        startLevel: 0,               // begin on the lowest rendition
        capLevelToPlayerSize: false,
        maxBufferLength: 6,
        maxMaxBufferLength: 12,
        autoStartLoad: true,
      });
      hls.loadSource(url);
      hls.attachMedia(vid);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Fix to the lowest level: disables ABR so the preview stays cheap.
        hls.currentLevel = 0;
        hls.nextLevel = 0;
        hls.loadLevel = 0;
      });
    } else {
      // Safari / iOS: native HLS (no rendition pinning, but functional).
      vid.src = url;
    }
  }

  function onSeeked() {
    if (pendingTime != null) {
      const t = pendingTime;
      pendingTime = null;
      seekTo(t);
    }
  }
  vid.addEventListener('seeked', onSeeked);

  function seekTo(t) {
    if (!isFinite(t)) return;
    if (vid.seeking) { pendingTime = t; return; }   // coalesce rapid moves
    if (Math.abs(t - lastSeek) < 0.2) return;        // skip sub-frame jitter
    lastSeek = t;
    try { vid.currentTime = t; } catch { /* metadata not ready yet */ }
  }

  function fmt(t) {
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
  }

  // The seek bar is the geometry reference for hover→time mapping.
  function seekBarEl() {
    const pc = player.controlBar && player.controlBar.progressControl;
    return pc && pc.seekBar && pc.seekBar.el();
  }

  function show() { wrap.classList.add('visible'); }
  function hide() { wrap.classList.remove('visible'); }

  function update(clientX) {
    const bar = seekBarEl();
    const dur = player.duration();
    if (!bar || !isFinite(dur) || dur <= 0) return;

    const barRect = bar.getBoundingClientRect();
    let frac = (clientX - barRect.left) / barRect.width;
    frac = Math.min(1, Math.max(0, frac));
    const t = frac * dur;
    seekTo(t);
    timeEl.textContent = fmt(t);

    // Centre the thumbnail on the cursor, clamped inside the player.
    const pRect = playerEl.getBoundingClientRect();
    const half = (wrap.offsetWidth || 160) / 2;
    let left = clientX - pRect.left;
    left = Math.min(pRect.width - half - 4, Math.max(half + 4, left));
    wrap.style.left = `${left}px`;
    show();
  }

  // ── Pointer wiring: hover (mouse) + drag (touch) on the progress control ──
  const pc = player.controlBar
    && player.controlBar.progressControl
    && player.controlBar.progressControl.el();
  let dragging = false;

  const onMove = (e) => {
    if (e.pointerType === 'touch' && !dragging) return; // touch: only while dragging
    update(e.clientX);
  };
  const onDown = (e) => {
    if (e.pointerType === 'touch') { dragging = true; update(e.clientX); }
  };
  const onUp = () => { if (dragging) { dragging = false; hide(); } };
  const onLeave = (e) => { if (!e || e.pointerType !== 'touch') hide(); };

  if (pc) {
    pc.addEventListener('pointermove', onMove);
    pc.addEventListener('pointerdown', onDown);
    pc.addEventListener('pointerleave', onLeave);
    // Window-level so a touch drag that escapes the bar still tracks/ends.
    window.addEventListener('pointermove', (e) => { if (dragging) update(e.clientX); });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  return {
    setSource,
    destroy() {
      teardownHls();
      if (pc) {
        pc.removeEventListener('pointermove', onMove);
        pc.removeEventListener('pointerdown', onDown);
        pc.removeEventListener('pointerleave', onLeave);
      }
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      try { wrap.remove(); } catch { /* noop */ }
    },
  };
}
