/* The creator TIMELINE in the player: link toasters and chapter marks.
 *
 * TOASTERS. A video's author can pin links to moments of it (a 3Speak video, a Hive
 * profile, any web page). Each shows as a small card at the TOP RIGHT from `at` for
 * `dur` content seconds, can be dismissed, and opens in a NEW TAB: this player is
 * usually inside somebody else's page, which must never be navigated away under them.
 *
 * - Content time, never the file's clock. A stitched ad makes the file longer than
 *   the creator's video, so every position past the cut is shifted; the caller maps
 *   it back (adBreak.contentTime), exactly as the ticker and the watch tracker do.
 * - Never while an ad is on screen or about to be (the caller's `adHold`), and the
 *   stack sits BELOW whatever already owns the top-right corner: the ticker band and
 *   the muted-autoplay button. Measured, not assumed, so it follows them through
 *   resizes and fullscreen.
 * - Built with textContent only. Titles are user data from the chain.
 *
 * CHAPTERS. Small gaps on the seek bar at each chapter start (drawn in content time,
 * like the bar itself) and the chapter's title in the scrub preview.
 */
import { activeLinks, chapterAt, linkHref } from '../timeline.js';

const COMPACT_PX = 480;   // same breakpoint as the sponsor disclosure
const TINY_PX = 300;
const EDGE = 10;          // inset from the frame, as the logo and the muted button
const GAP = 8;            // clearance below anything already in the corner
// What owns the top of the frame already. Only measured while visible.
const OBSTACLES = ['.vjs-ticker', '.vjs-muted-autoplay-info.visible'];

const SVG_NS = 'http://www.w3.org/2000/svg';

function linkGlyph() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z');
  p.setAttribute('fill', 'currentColor');
  svg.appendChild(p);
  return svg;
}

function avatar(account) {
  const img = document.createElement('img');
  img.className = 'vjs-link-toast-avatar';
  img.src = 'https://images.hive.blog/u/' + encodeURIComponent(account) + '/avatar/small';
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  return img;
}

/** What a card says: a small kicker line and the title. */
function describe(link) {
  if (link.kind === 'video') {
    return { kicker: 'Video · @' + link.author, title: link.title || 'Watch on 3Speak' };
  }
  if (link.kind === 'profile') {
    return link.title
      ? { kicker: 'Channel · @' + link.account, title: link.title }
      : { kicker: 'Channel', title: '@' + link.account };
  }
  return link.title
    ? { kicker: link.site || 'Link', title: link.title }
    : { kicker: 'Link', title: link.site || link.url };
}

/**
 * @param {import('video.js').Player} player
 * @param {{ contentTime(t:number):number, contentDuration():(number|null),
 *           adHold(t:number):boolean }} hooks
 */
export function createTimelineUI(player, hooks) {
  let timeline = null;              // sanitised { chapters, links } or null
  let dismissed = new Set();        // link indices closed on this playback
  const cards = new Map();          // link index -> card element
  let stack = null;                 // the top-right container
  let marks = null;                 // chapter gaps inside the seek bar
  let marksFor = null;              // content length the gaps were drawn for

  function host() { return player && player.el && player.el(); }

  function seekBarEl() {
    const pc = player.controlBar && player.controlBar.progressControl;
    return (pc && pc.seekBar && pc.seekBar.el()) || null;
  }

  function ensureStack() {
    if (stack && stack.isConnected) return stack;
    const h = host();
    if (!h) return null;
    stack = document.createElement('div');
    stack.className = 'vjs-link-toasts';
    // Never let a tap reach video.js, which would toggle playback instead.
    ['click', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick'].forEach((ev) => {
      stack.addEventListener(ev, (e) => e.stopPropagation());
    });
    h.appendChild(stack);
    return stack;
  }

  function buildCard(link, index) {
    const href = linkHref(link);
    if (!href) return null;
    const { kicker, title } = describe(link);

    const card = document.createElement('div');
    card.className = 'vjs-link-toast vjs-link-toast-' + link.kind;
    card.setAttribute('role', 'note');

    const a = document.createElement('a');
    a.className = 'vjs-link-toast-main';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow ugc';
    a.title = title;
    a.setAttribute('aria-label', title + ' (opens in a new tab)');
    // The viewer is going to look at something else: keep their place here.
    a.addEventListener('click', () => {
      try { if (!player.paused()) player.pause(); } catch (_) { /* the link still opens */ }
    });

    const icon = document.createElement('span');
    icon.className = 'vjs-link-toast-icon';
    if (link.kind === 'video') icon.appendChild(avatar(link.author));
    else if (link.kind === 'profile') icon.appendChild(avatar(link.account));
    else icon.appendChild(linkGlyph());
    a.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'vjs-link-toast-text';
    const k = document.createElement('span');
    k.className = 'vjs-link-toast-kicker';
    k.textContent = kicker;
    const t = document.createElement('span');
    t.className = 'vjs-link-toast-title';
    t.textContent = title;
    text.appendChild(k);
    text.appendChild(t);
    a.appendChild(text);
    card.appendChild(a);

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'vjs-link-toast-close';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    x.addEventListener('click', (e) => {
      e.preventDefault();
      dismissed.add(index);
      removeCard(index);
    });
    card.appendChild(x);

    // Slide in on the next frame, so the transition has a start state.
    requestAnimationFrame(() => card.classList.add('is-in'));
    return card;
  }

  function removeCard(index) {
    const el = cards.get(index);
    if (el) el.remove();
    cards.delete(index);
  }

  function clearCards() {
    for (const i of Array.from(cards.keys())) removeCard(i);
  }

  /** Top of the stack: below every obstacle in the right half of the frame. */
  function placeStack(h) {
    const box = h.getBoundingClientRect();
    let top = EDGE;
    for (const sel of OBSTACLES) {
      const el = h.querySelector(sel);
      if (!el || el.style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right < box.left + box.width / 2) continue;
      top = Math.max(top, Math.round(r.bottom - box.top + GAP));
    }
    const v = top + 'px';
    if (stack.style.top !== v) stack.style.top = v;
    const w = box.width;
    stack.classList.toggle('is-compact', w > 0 && w < COMPACT_PX);
    stack.classList.toggle('is-tiny', w > 0 && w < TINY_PX);
    return w;
  }

  function updateToasts(playerTime) {
    const links = timeline ? timeline.links : null;
    const h = host();
    const hold = !links || !links.length || !h
      || !player.hasStarted() || player.ended()
      || hooks.adHold(playerTime);
    if (hold) { clearCards(); return; }

    const t = hooks.contentTime(playerTime);
    const due = activeLinks(links, t)
      .map((l) => links.indexOf(l))
      .filter((i) => !dismissed.has(i));
    if (!due.length && !cards.size) return;
    if (!ensureStack()) return;
    const w = placeStack(h);
    // Newest on top; a small embed has room for one card, a full player for two.
    const keep = due.slice(-(w > 0 && w < COMPACT_PX ? 1 : 2)).reverse();

    for (const i of Array.from(cards.keys())) {
      if (!keep.includes(i)) removeCard(i);
    }
    keep.forEach((i, pos) => {
      let el = cards.get(i);
      if (!el) {
        el = buildCard(links[i], i);
        if (!el) { dismissed.add(i); return; }
        cards.set(i, el);
      }
      // Keep DOM order equal to `keep` order (newest first).
      if (stack.children[pos] !== el) stack.insertBefore(el, stack.children[pos] || null);
    });
  }

  function drawMarks() {
    const bar = seekBarEl();
    const chapters = timeline ? timeline.chapters : null;
    const d = hooks.contentDuration();
    const want = bar && chapters && chapters.length > 1 && d > 0 ? d : null;
    if (want === marksFor && (!want || (marks && marks.isConnected))) return;
    marksFor = want;
    if (marks) { marks.remove(); marks = null; }
    if (!want) return;
    if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
    marks = document.createElement('div');
    marks.className = 'vjs-chapter-marks';
    marks.setAttribute('aria-hidden', 'true');
    for (const c of chapters) {
      if (c.start <= 0 || c.start >= want) continue;
      const g = document.createElement('span');
      g.className = 'vjs-chapter-gap';
      g.style.left = ((c.start / want) * 100).toFixed(3) + '%';
      marks.appendChild(g);
    }
    bar.appendChild(marks);
  }

  function update(playerTime) {
    const t = Number.isFinite(playerTime) ? playerTime : player.currentTime();
    updateToasts(t);
    drawMarks();
  }

  const refresh = () => { try { update(player.currentTime()); } catch (_) { /* best effort */ } };
  ['seeked', 'ended', 'play', 'playerresize', 'fullscreenchange', 'durationchange', 'loadedmetadata']
    .forEach((ev) => player.on(ev, refresh));

  return {
    /** A SANITISED timeline (see ../timeline.js), or null for none. */
    setTimeline(tl) {
      timeline = tl && (tl.links.length || tl.chapters.length) ? tl : null;
      dismissed = new Set();
      clearCards();
      marksFor = undefined; // force a redraw (or a removal)
      drawMarks();
    },
    update,
    /** The chapter title at a fraction of the seek bar, or ''. */
    chapterLabel(frac) {
      const chapters = timeline ? timeline.chapters : null;
      const d = hooks.contentDuration();
      if (!chapters || chapters.length < 2 || !(d > 0) || !Number.isFinite(frac)) return '';
      const c = chapterAt(chapters, Math.min(1, Math.max(0, frac)) * d);
      return c ? c.title : '';
    },
  };
}
