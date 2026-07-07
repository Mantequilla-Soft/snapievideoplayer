/**
 * "Most replayed" heatmap for the video.js seek bar (YouTube-style).
 *
 * Fetches the aggregate timeline-coverage buckets for the current video
 * (GET /api/heatmap → { tracked, sessions, normalized:[0..1] }) and renders a
 * small area graph directly above the seek bar: taller = watched/rewatched more.
 *
 * It's appended INSIDE the seek-bar element so it always spans the exact 0–100%
 * timeline width and fades in/out together with the control bar. pointer-events
 * stay off so it never interferes with scrubbing or the hover preview.
 *
 * @param {import('video.js').Player} player
 * @returns {{ setVideo(owner:string, permlink:string, type:string):void, destroy():void }}
 */

// A "most replayed" curve only means something with a few independent viewers —
// below this we hide it (avoids showing one person's path as if it were a trend).
const MIN_SESSIONS = 2;

export function createHeatmap(player) {
  const pc = player.controlBar && player.controlBar.progressControl;
  const seekBar = pc && pc.seekBar && pc.seekBar.el();
  if (!seekBar) return { setVideo() {}, destroy() {} };

  // Host an absolutely-positioned child above the seek bar.
  if (getComputedStyle(seekBar).position === 'static') seekBar.style.position = 'relative';

  const wrap = document.createElement('div');
  wrap.className = 'vjs-replay-heatmap';
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  const fill = document.createElementNS(NS, 'path');
  fill.setAttribute('class', 'hm-fill');
  svg.appendChild(fill);
  wrap.appendChild(svg);
  seekBar.appendChild(wrap);

  let reqId = 0; // guards against a slow response for a previous video

  function hide() { wrap.classList.remove('visible'); }
  function show() { wrap.classList.add('visible'); }

  // Light 3-tap smoothing so the curve reads like YouTube's, not a bar chart.
  function smooth(arr) {
    const n = arr.length;
    if (n < 3) return arr.slice();
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = arr[i - 1] != null ? arr[i - 1] : arr[i];
      const b = arr[i];
      const c = arr[i + 1] != null ? arr[i + 1] : arr[i];
      out[i] = (a + 2 * b + c) / 4;
    }
    return out;
  }

  function render(normalized) {
    const vals = smooth(normalized);
    const n = vals.length;
    if (n < 2) { hide(); return; }
    const x = (i) => (i / (n - 1)) * 100;
    const y = (v) => 100 - Math.max(0, Math.min(1, v)) * 100;

    let top = `M${x(0).toFixed(2)},${y(vals[0]).toFixed(2)}`;
    for (let i = 1; i < n; i++) top += ` L${x(i).toFixed(2)},${y(vals[i]).toFixed(2)}`;
    fill.setAttribute('d', `M0,100 L${x(0).toFixed(2)},${y(vals[0]).toFixed(2)} ${top.slice(1)} L100,100 Z`);
    show();
  }

  async function setVideo(owner, permlink, type) {
    hide();
    if (!owner || !permlink) return;
    const mine = ++reqId;
    const t = type === 'legacy' ? 'legacy' : 'embed';
    try {
      const res = await fetch(`/api/heatmap?v=${encodeURIComponent(owner)}/${encodeURIComponent(permlink)}&type=${t}`);
      if (mine !== reqId) return; // a newer video was loaded meanwhile
      const data = await res.json().catch(() => null);
      if (mine !== reqId) return;
      if (!data || !data.tracked || (data.sessions || 0) < MIN_SESSIONS
          || !Array.isArray(data.normalized) || !data.normalized.some((v) => v > 0)) {
        hide();
        return;
      }
      render(data.normalized);
    } catch {
      hide(); // best-effort — never disrupt playback
    }
  }

  return {
    setVideo,
    destroy() { try { wrap.remove(); } catch { /* noop */ } },
  };
}
