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
  let session = null;      // { sid, position, durationSeconds, label, advertiser }
  let window_ = null;      // { start, duration } in PLAYER time, once resolved
  let premium = false;     // this viewer pays for Pro, so playback is ad-free

  return {
    get active() { return !!session; },
    get info() { return session; },
    get resolved() { return !!window_; },
    /** True when the server said this playback is ad-free because the viewer is Pro. */
    get isPremiumViewer() { return premium; },

    /**
     * Ask whether this playback carries a spot. Returns the stitched manifest URL,
     * or null to play the content manifest exactly as before.
     */
    async request({ owner, permlink, viewer, country, manifestUrl }) {
      session = null;
      window_ = null;
      premium = false;
      if (!owner || !permlink || !manifestUrl) return null;
      try {
        const res = await fetch(`${AD_BASE}/m/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            owner, permlink, viewer: viewer || null, country: country || null, manifestUrl, capId: CAP_ID,
          }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        premium = data?.premium === true;
        if (!data || !data.ad || !data.ad.manifestUrl) return null;

        const sid = (data.ad.manifestUrl.match(/\/m\/([0-9a-f]{32})\.m3u8/) || [])[1];
        if (!sid) return null;
        session = {
          sid,
          position: data.ad.position,
          durationSeconds: data.ad.durationSeconds,
          label: data.ad.label || 'Sponsored',
          advertiser: data.ad.advertiser || null,
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
      if (!session || window_) return window_;
      for (let i = 0; i < RESOLVE_TRIES; i += 1) {
        try {
          const res = await fetch(`${AD_BASE}/m/${session.sid}/i`);
          if (res.ok) {
            const d = await res.json();
            if (typeof d.adStartAt === 'number' && d.adDurationSeconds) {
              window_ = { start: d.adStartAt, duration: d.adDurationSeconds };
              return window_;
            }
          }
        } catch (_) { /* keep trying */ }
        await sleep(RESOLVE_DELAY_MS);
      }
      return null;
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

    reset() { session = null; window_ = null; premium = false; },
  };
}
