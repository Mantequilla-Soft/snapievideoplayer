/**
 * Client half of server-side ad insertion.
 *
 * The spot is already inside the playlist by the time the player sees it, so there
 * is nothing here that fetches an ad, and nothing a blocker can match. What this
 * module does is the bookkeeping the player cannot do without help:
 *
 *  1. ASK whether this playback carries a spot at all, and swap the source for the
 *     stitched manifest if so.
 *  2. MAP the player's timeline back to content time. This is the important one. In
 *     a stitched stream `currentTime` includes the ad, so every second of ad would
 *     otherwise be recorded as watch time against the creator's video — and the
 *     retention data the ad forecast is built from would be poisoned by the ads it
 *     sells. The break offset comes from the stitcher, because the cut lands on a
 *     segment boundary rather than on the booked second and only the server knows
 *     where that fell.
 *  3. Tell the page when the playhead is inside the break, so a Sponsored label can
 *     be shown. Disclosure is required, and a label in the player chrome is not
 *     something a filter list removes without breaking playback.
 *
 * Every failure path is silent and returns "no ad". A video must never fail to play
 * because the ad system had a bad day.
 */

const AD_BASE = (typeof window !== 'undefined' && window.__AD_BASE__)
  || 'https://checker.3speak.tv';

// The stitcher only learns where the cut fell when a variant playlist is requested,
// which happens a beat after the source is set. Retry briefly rather than guess —
// a wrong offset silently corrupts watch data, which is worse than no label.
const RESOLVE_TRIES = 6;
const RESOLVE_DELAY_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Frequency-cap id for a viewer we cannot name.
 *
 * Generated per page load and held in a module variable — never localStorage, never
 * a cookie. It dies with the tab, so it caps how often one browsing session sees the
 * same spot without ever becoming a durable anonymous identifier. A persisted one
 * would be a viewing profile in all but name, which is exactly what the watch
 * tracking on this player was built to avoid.
 */
/**
 * Which ADS this viewer has already been shown recently, so the same advertiser does
 * not follow them from one video to the next.
 *
 * 🚨 Per AD, not per viewer. The server has always capped repeats of the same
 * campaign, but it keys that on the signed-in name or on CAP_ID — and CAP_ID below is
 * per PAGE LOAD by design, so without this the cap resets on every reload and one
 * advertiser can run a whole session. That is exactly what it did here: this player
 * kept its own copy of adBreak and never sent the list, so the same spot came back
 * over and over while the watch page had already stopped repeating.
 *
 * Stored as opaque `adKey`s with the time each was seen. Not viewing history: it says
 * which ADVERTS were shown, never which videos were watched, and entries expire on
 * their own inside the cap window. Sending it can only cost the viewer ads, never
 * earn them extra, which is why the server accepts it without trusting it.
 *
 * ⚠️ Kept in step with preview-3speak/src/lib/adBreak.js by hand, like the rest of
 * this file — the header explains why the duplication is deliberate. Same storage
 * key on purpose, so an embed and the watch page share one notion of "already seen".
 */
const SEEN_KEY = '3speak-ads-seen';
const SEEN_MINUTES = 30;   // matches AD_FREQUENCY_CAP_MINUTES on the server

function readSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
    const cutoff = Date.now() - SEEN_MINUTES * 60 * 1000;
    const out = {};
    for (const [k, t] of Object.entries(raw)) if (Number(t) > cutoff) out[k] = Number(t);
    return out;
  } catch { return {}; }
}

function recentAdKeys() {
  return Object.keys(readSeen());
}

function rememberAdSeen(...keys) {
  const flat = keys.flat().filter((k) => typeof k === 'string' && k);
  if (!flat.length) return;
  try {
    const seen = readSeen();
    const now = Date.now();
    for (const k of flat) seen[k] = now;
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch { /* storage unavailable — the server still caps a signed-in viewer */ }
}

const CAP_ID = (() => {
  try {
    const a = new Uint8Array(12);
    (globalThis.crypto || {}).getRandomValues?.(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return null;
  }
})();

export function createAdBreak() {
  let session = null;      // { sid, position, durationSeconds, label, advertiser, brand }
  // The banner is a SEPARATE placement, from a separate advertiser, and can be
  // present with or without a spot. It adds no time to the timeline, so it never
  // affects contentTime(): the picture changes, the clock does not.
  let banner = null;
  let bannerWindow = null;
  // A banner-only playback still has a session to ask /i about, and it is the same
  // sid, but it is read from the banner's own manifest URL because that is the only
  // one present in that case.
  let bannerSid = null;
  let window_ = null;      // { start, duration } in PLAYER time, once resolved
  let premium = false;     // this viewer pays for Pro, so playback is ad-free

  return {
    get active() { return !!session; },
    get info() { return session; },
    get resolved() { return !!window_; },
    /** True when the server said this playback is ad-free because the viewer is Pro. */
    get isPremiumViewer() { return premium; },

    /** The banner running on this playback, or null. */
    get bannerInfo() { return banner; },

    /**
     * Is the banner on screen at this moment?
     *
     * Measured in CONTENT time, because that is what the banner's position is a
     * percentage of and what the stitcher burned it against. On a playback that also
     * carries a spot, player time runs ahead of content time by the length of the
     * break, so comparing raw player time would put the click target in the wrong
     * place for exactly as long as the spot lasted.
     */
    isBannerVisible(playerTime) {
      if (!bannerWindow || !isFinite(playerTime)) return false;
      const t = this.contentTime(playerTime);
      return t >= bannerWindow.start && t < bannerWindow.start + bannerWindow.duration;
    },

    /**
     * Ask whether this playback carries a spot. Returns the stitched manifest URL,
     * or null to play the content manifest exactly as before.
     */
    async request({ owner, permlink, viewer, country, manifestUrl }) {
      session = null;
      window_ = null;
      banner = null;
      bannerWindow = null;
      bannerSid = null;
      premium = false;
      if (!owner || !permlink || !manifestUrl) return null;
      try {
        const res = await fetch(`${AD_BASE}/m/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            owner, permlink, viewer: viewer || null, country: country || null, manifestUrl, capId: CAP_ID,
            recentAdKeys: recentAdKeys(),
          }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        premium = data?.premium === true;
        // Recorded as soon as the server hands one over, and BEFORE the early return
        // below: a banner-only playback is still an ad this viewer was shown, and
        // returning first would have left it out of the cap.
        rememberAdSeen(data?.ad?.adKey, data?.banner?.adKey);

        // Kept whether or not there is also a spot: a playback can carry a banner
        // alone, and then the banner's manifest is the one to load.
        if (data && data.banner && data.banner.manifestUrl) {
          bannerSid = (data.banner.manifestUrl.match(/\/m\/([0-9a-f]{32})\.m3u8/) || [])[1] || null;
          banner = {
            positionPercent: data.banner.positionPercent,
            durationSeconds: data.banner.durationSeconds,
            advertiser: data.banner.advertiser || null,
            brand: data.banner.brand || null,
            // Where the server burned it, in frame percentages. Never assumed here.
            placement: data.banner.placement || null,
            manifestUrl: data.banner.manifestUrl,
          };
        }

        if (!data || !data.ad || !data.ad.manifestUrl) {
          // No spot, but a banner still needs its manifest loaded and its window
          // resolved, so report the banner's manifest as the thing to play.
          return banner ? banner.manifestUrl : null;
        }

        const sid = (data.ad.manifestUrl.match(/\/m\/([0-9a-f]{32})\.m3u8/) || [])[1];
        if (!sid) return null;
        session = {
          sid,
          position: data.ad.position,
          durationSeconds: data.ad.durationSeconds,
          label: data.ad.label || 'Sponsored',
          advertiser: data.ad.advertiser || null,
          // Who the ad is from, for the disclosure: logo, product, slogan, and the
          // click URL. Absent fields are fine — the overlay draws what is there.
          brand: data.ad.brand || null,
        };
        return data.ad.manifestUrl;
      } catch (_) {
        return null;      // no ad is always an acceptable answer
      }
    },

    /**
     * Learn where the break actually landed. Call once playback has started.
     * Until this resolves, contentTime() is the identity — better to under-report
     * the offset briefly than to subtract a number we invented.
     */
    async resolve() {
      // A banner-only playback has no spot sid, so the id comes from whichever
      // placement produced the manifest.
      const sid = (session && session.sid) || bannerSid;
      if (!sid) return window_;
      // Keep asking while EITHER window is still missing: a playback can carry both,
      // and the banner's offsets can land in a later poll than the spot's.
      if (window_ && (!banner || bannerWindow)) return window_;
      for (let i = 0; i < RESOLVE_TRIES; i += 1) {
        try {
          const res = await fetch(`${AD_BASE}/m/${sid}/i`);
          if (res.ok) {
            const d = await res.json();
            if (banner && !bannerWindow
              && typeof d.bannerStartAt === 'number' && d.bannerDurationSeconds) {
              bannerWindow = { start: d.bannerStartAt, duration: d.bannerDurationSeconds };
            }
            if (!window_ && typeof d.adStartAt === 'number' && d.adDurationSeconds) {
              window_ = { start: d.adStartAt, duration: d.adDurationSeconds };
            }
            if ((!session || window_) && (!banner || bannerWindow)) return window_;
          }
        } catch (_) { /* keep trying */ }
        await sleep(RESOLVE_DELAY_MS);
      }
      return window_;
    },

    /** Seconds until the break starts, or null when that is not a useful question. */
    secondsUntil(playerTime) {
      if (!window_ || !isFinite(playerTime)) return null;
      const left = window_.start - playerTime;
      return left > 0 ? left : null;
    },

    /**
     * Seconds until the content resumes, or null when not inside the break. Same
     * window the disclosure and the watch tracker use, so the number on screen can
     * never disagree with when the video actually comes back.
     */
    secondsRemaining(playerTime) {
      if (!window_ || !isFinite(playerTime)) return null;
      const { start, duration } = window_;
      if (playerTime < start || playerTime >= start + duration) return null;
      return Math.max(0, start + duration - playerTime);
    },

    /** Seconds until the break starts, or null when that is not a useful question. */
    secondsUntil(playerTime) {
      if (!window_ || !isFinite(playerTime)) return null;
      const left = window_.start - playerTime;
      return left > 0 ? left : null;
    },

    /** Is the playhead inside the break right now? */
    isInside(playerTime) {
      if (!window_ || !isFinite(playerTime)) return false;
      return playerTime >= window_.start && playerTime < window_.start + window_.duration;
    },

    /**
     * Player time → content time.
     *
     * Inside the break the content has not advanced at all, so it pins to the cut
     * point; after it, the ad's duration comes off. This is what keeps ad seconds
     * out of `view-durations`.
     */
    contentTime(playerTime) {
      if (!window_ || !isFinite(playerTime)) return playerTime;
      const { start, duration } = window_;
      if (playerTime < start) return playerTime;
      if (playerTime < start + duration) return start;
      return playerTime - duration;
    },

    /** How much of the visible timeline is ad, for duration-facing UI. */
    get addedSeconds() { return window_ ? window_.duration : 0; },

    reset() { session = null; window_ = null; banner = null; bannerWindow = null; bannerSid = null; premium = false; },
  };
}
