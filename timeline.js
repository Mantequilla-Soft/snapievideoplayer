'use strict';

/* The creator TIMELINE: chapters and link toasters a video's author attaches to it.
 *
 * Lives in the Hive post, `json_metadata.video` (shared format with the 3speak.tv
 * upload "Timeline" step, the watch page and the edit dialog):
 *
 *   video: { timeline_v: 1,
 *     chapters: [ { start: 0, title: "Intro" }, { start: 95, title: "Setup" } ],
 *     links: [ { at: 42, dur: 8, kind: "video", author, permlink, title },
 *              { at: 120, dur: 8, kind: "profile", account },
 *              { at: 300, dur: 8, kind: "url", url, title, site } ] }
 *
 * 🚨 IT IS USER DATA FROM THE CHAIN. Anyone can write any JSON into a post, so every
 * field is checked here and anything that does not pass is DROPPED, never repaired
 * into something else. Shared by the server (which sends the result in /api/watch and
 * /api/embed) and the player bundle (which checks again, because the API is not the
 * only thing that can hand it a timeline).
 *
 * All times are CONTENT seconds: the creator's video, never a stitched file with an ad
 * spliced in. Mapping to the player's clock is the player's job.
 *
 * CommonJS on purpose: server.js require()s it on any Node the player is deployed on,
 * and webpack bundles CommonJS as happily as ESM.
 */

const MAX_CHAPTERS = 50;
const MAX_LINKS = 20;
const TITLE_MAX = 100;
const URL_MAX = 500;
const DUR_MIN = 3;
const DUR_MAX = 60;
const DUR_DEFAULT = 8;
// Nobody uploads a two-day video; anything beyond is junk, not a position.
const MAX_SECONDS = 48 * 3600;
// Bound the work done on an oversized array before any item is looked at.
const RAW_SCAN_MAX = 200;

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
// Hive permlinks are lowercase letters, digits and hyphens, at most 256 long.
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;

// C0/C1 controls, plus the bidi overrides and isolates that can make a title render
// as something other than what it says.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

function isAccount(v) {
  return typeof v === 'string' && ACCOUNT_RE.test(v);
}

function isPermlink(v) {
  return typeof v === 'string' && PERMLINK_RE.test(v);
}

/** A display string: plain text, single-spaced, at most `max` characters, or ''. */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(UNSAFE_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // By code point, so a cut never splits an emoji into a lone surrogate.
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('').trim() : s;
}

/** A position in content seconds, or null. Numbers only, as the format says. */
function seconds(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_SECONDS) return null;
  return Math.round(v * 1000) / 1000;
}

function handle(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * An http(s) URL safe to put in an href, normalised, or null.
 * No credentials: `https://3speak.tv@evil.example/` reads as 3speak.tv and is not.
 */
function safeUrl(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > URL_MAX) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || !u.hostname) return null;
  const href = u.href;
  return href.length > URL_MAX ? null : href;
}

/** The host a URL really points at, for display ("example.com"). */
function siteOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function sanitizeChapters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const c of raw.slice(0, RAW_SCAN_MAX)) {
    if (!c || typeof c !== 'object') continue;
    const start = seconds(c.start);
    const title = cleanText(c.title, TITLE_MAX);
    if (start == null || !title || seen.has(start)) continue;
    seen.add(start);
    out.push({ start, title });
  }
  out.sort((a, b) => a.start - b.start);
  return out.slice(0, MAX_CHAPTERS);
}

function sanitizeLink(l) {
  if (!l || typeof l !== 'object') return null;
  const at = seconds(l.at);
  if (at == null) return null;
  // A missing or unreadable length gets the default; a readable one is clamped.
  const d = typeof l.dur === 'number' && Number.isFinite(l.dur) ? l.dur : DUR_DEFAULT;
  const dur = Math.round(Math.min(DUR_MAX, Math.max(DUR_MIN, d)) * 1000) / 1000;
  const title = cleanText(l.title, TITLE_MAX);

  if (l.kind === 'video') {
    const author = handle(l.author);
    const permlink = handle(l.permlink);
    if (!isAccount(author) || !isPermlink(permlink)) return null;
    const out = { at, dur, kind: 'video', author, permlink };
    if (title) out.title = title;
    return out;
  }
  if (l.kind === 'profile') {
    const account = handle(l.account);
    if (!isAccount(account)) return null;
    const out = { at, dur, kind: 'profile', account };
    if (title) out.title = title;
    return out;
  }
  if (l.kind === 'url') {
    const url = safeUrl(l.url);
    if (!url) return null;
    // The site shown is the one the link REALLY goes to. A `site` from the post is
    // ignored: it could say 3speak.tv over a link to somewhere else.
    const out = { at, dur, kind: 'url', url, site: siteOf(url) };
    if (title) out.title = title;
    return out;
  }
  return null;
}

function sanitizeLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const l of raw.slice(0, RAW_SCAN_MAX)) {
    const ok = sanitizeLink(l);
    if (ok) out.push(ok);
  }
  // Stable sort: two links at the same second keep the author's order.
  out.sort((a, b) => a.at - b.at);
  return out.slice(0, MAX_LINKS);
}

/**
 * `json_metadata.video` (or an already-sanitised { chapters, links }) →
 * { chapters, links } with only valid items, or null when nothing survives.
 */
function sanitizeTimeline(video) {
  if (!video || typeof video !== 'object' || Array.isArray(video)) return null;
  const chapters = sanitizeChapters(video.chapters);
  const links = sanitizeLinks(video.links);
  if (!chapters.length && !links.length) return null;
  return { chapters, links };
}

/** Where a sanitised link opens. null for anything that is not one. */
function linkHref(link) {
  if (!link || typeof link !== 'object') return null;
  if (link.kind === 'video' && isAccount(link.author) && isPermlink(link.permlink)) {
    return 'https://3speak.tv/watch?v=' + link.author + '/' + link.permlink;
  }
  if (link.kind === 'profile' && isAccount(link.account)) {
    // /p/ is the profile route 3speak.tv links to everywhere (/user/ is an alias).
    return 'https://3speak.tv/p/' + link.account;
  }
  if (link.kind === 'url') return safeUrl(link.url);
  return null;
}

/** Links on screen at content second `t`, in the author's order. */
function activeLinks(links, t) {
  if (!Array.isArray(links) || !Number.isFinite(t)) return [];
  return links.filter((l) => t >= l.at && t < l.at + l.dur);
}

/** The chapter content second `t` falls in, or null (before the first one). */
function chapterAt(chapters, t) {
  if (!Array.isArray(chapters) || !Number.isFinite(t)) return null;
  let hit = null;
  for (const c of chapters) {
    if (c.start <= t) hit = c;
    else break;
  }
  return hit;
}

module.exports = {
  MAX_CHAPTERS,
  MAX_LINKS,
  TITLE_MAX,
  URL_MAX,
  DUR_MIN,
  DUR_MAX,
  DUR_DEFAULT,
  isAccount,
  isPermlink,
  safeUrl,
  sanitizeTimeline,
  linkHref,
  activeLinks,
  chapterAt,
};
