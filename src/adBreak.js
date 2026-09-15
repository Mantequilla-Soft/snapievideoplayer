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

/* 🚨 HOW FAR PAST THE AD TO LAND, and why it is not a few milliseconds.
 *
 * The stitched playlist declares the ad's length from the ad's OWN manifest, and that
 * number is not the length of the media. A measured example: the playlist said 7.967s
 * for a segment whose container really runs 8.013s. The 46ms difference is ad that
 * exists in the bytes and not in the timeline, so it sits at the start of what the
 * arithmetic calls content — which is why the tail of an ad kept showing after a jump
 * that was, on paper, past the end of it.
 *
 * The drift belongs to each creative's encode, so it cannot be computed here. This is
 * a margin wide enough to clear it, paid for with a third of a second of the video at
 * a cut the viewer is being moved across anyway.
 */
const LANDING_MARGIN_S = 0.35;

/* How many seconds of warning a viewer gets before the break.
 *
 * Exported because it is now TWO decisions wearing one number: how long the "Ad in 3"
 * hint is on screen, and how long the seek lock is armed for. Those have to be the
 * same window or the hint tells the viewer to do something the lock then refuses,
 * which reads as the player being broken rather than as the ad being unskippable.
 */
export const AD_COUNTDOWN_FROM = 3;

/* How many seconds of a spot ON SCREEN make it a delivered impression.
 *
 * 🚨 Keep in step with AD_COUNT_AFTER_SECONDS on the checker, which is the one that
 * actually decides. This copy only says when to SEND the beat; the server credits it
 * against its own clock, so the two drifting apart costs a request, never a payout. */
export const AD_BILLABLE_SECONDS = 3;

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
  // Seconds into the spot at which a Skip may be offered, or null for never. The
  // SERVER decides: a player that worked it out itself could offer a skip on a spot
  // the server considers unskippable, and nothing would say which was right.
  let skipAfter = null;
  // Set once the spot has been passed for good; nothing shows its chrome after that.
  let spotRetired = false;
  /* Has this spot actually RUN?
   *
   * A spot that has been sat through is spent, and the seconds it occupies become a
   * hole in the timeline rather than something to serve again to somebody scrubbing
   * back over their own video. `entered` is what keeps that honest: dragging straight
   * past a spot that never played does not spend it. */
  let spotEntered = false;
  let spotConsumed = false;
  /* Has the countdown actually been on screen for this spot?
   *
   * The seek lock hangs off this rather than off the clock alone, because "the
   * playhead is near the cut" is also true at t=0 of a PRE-ROLL, where no countdown
   * ever runs — secondsUntil() is null there, the spot is already playing. Arming the
   * lock on position alone would therefore refuse the legitimate seeks that happen at
   * load, such as a ?t= deep link. The latch keeps the lock to what the viewer was
   * actually warned about: a break they watched count down. */
  let countdownSeen = false;
  /* Seconds of the spot that have really PLAYED, and the clock they are measured on.
   *
   * 🚨 Measured from the PLAYER's own time inside the break, not from wall clock and
   * not from segment fetches. Player time only advances while the media is actually
   * playing, so a pause contributes nothing without anyone having to notice the pause,
   * and a spot that was buffered but never reached contributes nothing either — which
   * is exactly what billing off segment fetches got wrong. */
  let adWatched = 0;
  let lastInsideAt = null;
  let watchBeatAt = 0;
  // Seconds into the banner before its close button may appear. The server decides.
  let bannerCloseAfter = 5;
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
     * May the banner be closed yet?
     *
     * Not from its first frame. An ad that can be dismissed instantly is an ad nobody
     * reads, and the advertiser bought seconds on screen rather than a button. The
     * threshold comes from the server so the burned banner and the drawn one cannot
     * disagree about a number that is really one decision.
     */
    bannerClosable(playerTime) {
      if (!bannerWindow || !isFinite(playerTime)) return false;
      const t = this.contentTime(playerTime);
      return (t - bannerWindow.start) >= bannerCloseAfter;
    },

    /** The creative to DRAW, when the server agreed to hand it over. Null when burned. */
    get bannerOverlay() { return (banner && banner.overlay) || null; },

    /**
     * An overlay banner was on screen for its booked time.
     *
     * A burned banner measures itself, because the player must fetch bytes only the
     * stitcher can produce. An overlay is drawn from a CDN asset and nothing about it
     * reaches the server, so this is the only signal there is. The server still refuses
     * a claim that arrives too early, so a page cannot bill an advertiser the moment it
     * loads.
     */
    reportBannerShown() {
      const sid = (session && session.sid) || bannerSid;
      if (!sid) return;
      fetch(`${AD_BASE}/m/${encodeURIComponent(sid)}/banner-shown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => { /* an unreported impression is the advertiser's loss, not a crash */ });
    },

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
      /* Never while the SPOT is playing. A banner is burned into the CONTENT's frames,
       * so during a break the picture is the ad and carries no banner. The window
       * arithmetic cannot see this on its own: contentTime() pins to the break's own
       * position for the whole break, so a banner booked over that position reads as
       * visible for every second of the spot. */
      if (this.isInside(playerTime)) return false;
      const t = this.contentTime(playerTime);
      return t >= bannerWindow.start && t < bannerWindow.start + bannerWindow.duration;
    },

    /**
     * Ask whether this playback carries a spot. Returns the stitched manifest URL,
     * or null to play the content manifest exactly as before.
     */
    async request({ owner, permlink, viewer, country, manifestUrl, bannerOverlay }) {
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
            /* Ask for the banner to be handed over rather than burned in, when this
             * player cannot close a burned one. The server does not guess: it is the
             * client that knows what it can do. */
            bannerOverlay: bannerOverlay === true,
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
            // The creative to DRAW, when the server handed it over instead of burning
            // it. Dropping this field was why an overlay banner never appeared: the
            // server sent the artwork, the client threw it away at the door, and the
            // only things left to render were the close button and a click target
            // over a banner that was never drawn.
            overlay: data.banner.overlay || null,
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
              // Read in the same breath as the window: a threshold without a window is
              // unusable, since canSkip needs both to say anything.
              skipAfter = typeof d.skipAfterSeconds === 'number' ? d.skipAfterSeconds : null;
            }
            if ((!session || window_) && (!banner || bannerWindow)) return window_;
          }
        } catch (_) { /* keep trying */ }
        await sleep(RESOLVE_DELAY_MS);
      }
      return window_;
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
      /* Nothing to warn about. A spot already watched is jumped rather than played,
       * so counting down to it announces an interruption that never arrives — and it
       * announced it again every time somebody re-watched the run-up to the cut. */
      if (spotConsumed) return null;
      const left = window_.start - playerTime;
      return left > 0 ? left : null;
    },

    /** Where the spot begins on the player's clock, or null. */
    spotStart() {
      return window_ ? window_.start : null;
    },

    /** Is the playhead inside the break right now? */
    isInside(playerTime) {
      if (!window_ || !isFinite(playerTime)) return false;
      // A RETIRED spot is never inside anything again. Every piece of spot chrome
      // funnels through here, so this silences the disclosure, the Skip and the resume
      // countdown together rather than leaving each to remember separately.
      if (spotRetired) return false;
      return playerTime >= window_.start && playerTime < window_.start + window_.duration;
    },

    /**
     * Whole seconds to show in the "Ad in N" hint, or null for no hint.
     *
     * The arithmetic lives here rather than in main.js because it also ARMS THE SEEK
     * LOCK. Two copies of "is the countdown up" is two chances for the lock to
     * disagree with the thing the viewer can see.
     */
    countdownAt(playerTime) {
      const left = this.secondsUntil(playerTime);
      if (left == null || left > AD_COUNTDOWN_FROM) return null;
      countdownSeen = true;
      return Math.max(1, Math.ceil(left));
    },

    /**
     * 🚨 Is the playhead under the no-skip lock?
     *
     * From the moment the countdown appears until the spot has been sat through. The
     * warning is otherwise an instruction: it told the viewer exactly when to drag the
     * handle, and the timeline let them, so a spot an advertiser paid for was skipped
     * by the very thing meant to make it bearable.
     *
     * Bounded by `spotConsumed` at one end and the latch at the other, so a spot that
     * has already run locks nothing — those seconds are a hole to be jumped, not an ad
     * to be protected — and a pre-roll nobody was warned about locks nothing either.
     */
    seekLocked(playerTime) {
      if (!window_ || !Number.isFinite(playerTime)) return false;
      if (spotConsumed || !countdownSeen) return false;
      return playerTime >= window_.start - AD_COUNTDOWN_FROM
          && playerTime < window_.start + window_.duration;
    },

    /**
     * Where a seek made under the lock must land instead, or null to let it through.
     *
     * Refusing means staying put, not being thrown forward: the viewer asked to leave
     * and the answer is no, so the playhead simply does not move.
     *
     * BACKWARDS IS ALWAYS ALLOWED. Rewinding out of the countdown is not a way past
     * the ad — the break is still in front of them and they will meet it again on the
     * way back. Blocking it would take the one control that costs the advertiser
     * nothing, and turn "you cannot skip this" into "you cannot move at all", which is
     * the version people take to be a bug.
     */
    lockedSeekTarget(playerTime, cameFrom) {
      if (!Number.isFinite(playerTime) || !Number.isFinite(cameFrom)) return null;
      if (!this.seekLocked(cameFrom)) return null;
      if (playerTime < window_.start) return null;   // going back, or still short of the cut
      if (playerTime <= cameFrom) return null;       // not a forward jump
      return cameFrom;
    },

    /**
     * This spot is done with, whatever the clock says.
     *
     * Closing a banner reloads the source, and a reload walks the playhead through
     * zero. A spot booked at the START of the video is inside its own window there, so
     * its chrome came back over a video that was merely reloading. That moment is not
     * knowable from a clock being reset, so the spot is retired outright instead.
     */
    retireSpot() { spotRetired = true; },
    get spotRetired() { return spotRetired; },

    /**
     * Where the spot sits on the player's clock, ignoring whether it is retired.
     *
     * isInside() answers "should spot chrome be on screen", which a retired spot
     * silences. This answers "are these seconds the ad", which stays true either way
     * and is what the seek guard has to ask.
     */
    spansSpot(playerTime) {
      if (!window_ || !isFinite(playerTime)) return false;
      return playerTime >= window_.start && playerTime < window_.start + window_.duration;
    },

    /**
     * Told the clock on every tick, so a spot that has run can be marked spent.
     *
     * Entering it is not enough on its own and neither is passing its end: a viewer
     * who drags the handle from before the spot to after it has done both without
     * seeing a frame of it. Both, in order, is what "watched" means here.
     */
    noteTime(playerTime) {
      if (!window_ || !isFinite(playerTime)) return;
      if (this.spansSpot(playerTime)) {
        spotEntered = true;
        if (lastInsideAt != null) {
          const step = playerTime - lastInsideAt;
          /* Forward, and small. A backward step is a rewind and a big one is a seek or
           * a tick that arrived late after a stall; neither is a second of ad anybody
           * watched. 2s is comfortably above the ~250ms a timeupdate really delivers
           * and far below any jump worth having. */
          if (step > 0 && step < 2) adWatched += step;
        }
        lastInsideAt = playerTime;
        // The billing beat, sent once, the moment the spot has been on screen long
        // enough to owe the creator for it.
        if (adWatched >= AD_BILLABLE_SECONDS && watchBeatAt === 0) {
          watchBeatAt = adWatched;
          this.reportWatched();
        }
        return;
      }
      /* Just left the break. The closing beat carries the full figure, so a spot
       * watched for nine seconds is on record as nine rather than frozen at the three
       * that billed it. Sent on the way OUT rather than per tick: one request for the
       * whole playback instead of one a second. */
      if (lastInsideAt != null) {
        lastInsideAt = null;
        if (adWatched > 0) this.reportWatched();
      }
      if (spotEntered && playerTime >= window_.start + window_.duration) spotConsumed = true;
    },

    /** Seconds of the spot that actually played. */
    get watchedSeconds() { return Math.round(adWatched * 100) / 100; },

    /**
     * Tell the server what really played. Fire and forget.
     *
     * `keepalive` so a beat sent as the page goes away still arrives, and every failure
     * swallowed: a video must never stutter because our accounting had a bad moment.
     */
    reportWatched() {
      const sid = session && session.sid;
      if (!sid || !(adWatched > 0)) return;
      try {
        fetch(`${AD_BASE}/m/${sid}/w`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seconds: Math.round(adWatched * 100) / 100 }),
          keepalive: true,
        }).catch(() => {});
      } catch { /* never the reason a video fails to play */ }
    },

    /** Has the spot been watched, or skipped, and become a hole in the timeline? */
    get spotConsumed() { return spotConsumed; },

    /**
     * Where to put the playhead when it lands in a spot that has already run.
     *
     * Null unless the spot is spent and the playhead is in it. Direction matters:
     * arriving from AFTER the spot means scrubbing back, and the viewer wants the
     * content before the ad rather than the ad again, so they are put in front of it.
     * Every other arrival is travelling forward and goes to the far side. Playing
     * forward off that landing point re-enters the spot and jumps it again, which is
     * the correct reading of a hole: the ad occupies no content time at all.
     */
    skipTargetFor(playerTime, cameFrom) {
      if (!spotConsumed || !this.spansSpot(playerTime)) return null;
      const end = window_.start + window_.duration;
      if (isFinite(cameFrom) && cameFrom >= end) {
        const before = window_.start - 0.05;
        /* A PRE-ROLL has nothing in front of it. Landing at 0 would be landing inside
         * the ad again, and the guard would immediately throw the playhead forward —
         * two seeks to reach the one place that was ever available. */
        return before > 0 ? before : end + LANDING_MARGIN_S;
      }
      return end + LANDING_MARGIN_S;
    },

    /**
     * Is a banner due within the next `lead` seconds (or on screen already)?
     *
     * So the clean copy can be fetched BEFORE the banner appears. Starting it when the
     * banner starts is too late: it needs seconds to buffer, and the viewer can reach
     * for the close button in the first of them — which is exactly the case that fell
     * through to a refetch and paused.
     */
    bannerDueWithin(playerTime, lead) {
      if (!bannerWindow || !isFinite(playerTime)) return false;
      const t = this.contentTime(playerTime);
      const end = bannerWindow.start + bannerWindow.duration;
      return t >= (bannerWindow.start - (lead || 0)) && t < end;
    },

    /** Does this spot offer a skip at all? Decided by the server, not here. */
    get skipOffered() { return skipAfter != null; },

    /** May the viewer skip yet? Inside the break, and past the server's threshold. */
    canSkip(playerTime) {
      if (skipAfter == null || !window_ || !isFinite(playerTime) || spotRetired) return false;
      const elapsed = playerTime - window_.start;
      return elapsed >= skipAfter && elapsed < window_.duration;
    },

    /** Seconds until skipping is allowed, or null when it already is (or never will be). */
    secondsUntilSkip(playerTime) {
      if (skipAfter == null || !window_ || !isFinite(playerTime)) return null;
      const left = (window_.start + skipAfter) - playerTime;
      return left > 0 ? left : null;
    },

    /**
     * Where the content resumes, for a player skipping the break. A hair PAST the end:
     * landing exactly on the boundary can leave the player one frame inside the spot,
     * which puts the disclosure back for an instant and reads as a failed skip.
     */
    endOfBreak() {
      return window_ ? window_.start + window_.duration + LANDING_MARGIN_S : null;
    },

    /**
     * The viewer pressed Skip. The server counts it as watched.
     *
     * The button only appears after the threshold, so a press means they sat through
     * the part we ask for and then chose to move on. Billing that is the honest
     * reading, and it means a skip costs us nothing, so it can stay generous rather
     * than becoming something we are tempted to make harder.
     */
    recordSkip() {
      // Pressing Skip spends the spot as surely as watching it out does. Without this
      // the timeline would offer it back the moment somebody scrubbed over it.
      spotConsumed = true;
      const sid = session && session.sid;
      if (!sid) return;
      fetch(`${AD_BASE}/m/${encodeURIComponent(sid)}/skipped`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => { /* the viewer still skips */ });
    },

    /**
     * The viewer closed the banner.
     *
     * ⚠️ RETURNS the request, and the caller must WAIT for it. The caller reloads the
     * source straight afterwards, and the playlist is only clean once the server knows.
     * Fire-and-forget is a race the viewer loses about half the time: the reload
     * arrives first, gets the burned playlist back, and closing appears to do nothing.
     */
    dismissBanner() {
      const sid = (session && session.sid) || bannerSid;
      banner = null;
      bannerWindow = null;
      if (!sid) return Promise.resolve();
      return fetch(`${AD_BASE}/m/${encodeURIComponent(sid)}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => { /* they still get the local hide */ });
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

    /**
     * Content time → the player's clock. The inverse of contentTime().
     *
     * What a timeline drawn in content seconds needs in order to seek: the viewer
     * points at a second of the creator's video, and this says where that second
     * actually lives in the stitched file.
     *
     * `<=` at the cut point on purpose. contentTime() collapses the WHOLE spot onto
     * `start`, so that one content second is where the playhead reads from while the
     * ad runs. Mapping it back to the far side would mean anything that round-trips
     * the displayed position — a control reading the clock and seeking to it — would
     * jump the viewer past an ad they had not watched.
     */
    playerTimeFor(contentSeconds) {
      if (!window_ || !isFinite(contentSeconds)) return contentSeconds;
      const { start, duration } = window_;
      return contentSeconds <= start ? contentSeconds : contentSeconds + duration;
    },

    /**
     * How long the creator's video is, with the spot taken back out.
     *
     * The stitched file is longer than the video by exactly the ad, and a timeline
     * measured against the file counts seconds the creator never made.
     */
    contentDuration(mediaDuration) {
      if (!window_ || !isFinite(mediaDuration)) return mediaDuration;
      return Math.max(0, mediaDuration - window_.duration);
    },

    /** How much of the visible timeline is ad, for duration-facing UI. */
    get addedSeconds() { return window_ ? window_.duration : 0; },

    reset() { session = null; window_ = null; skipAfter = null; spotRetired = false; spotEntered = false; spotConsumed = false; countdownSeen = false; adWatched = 0; lastInsideAt = null; watchBeatAt = 0; banner = null; bannerWindow = null; bannerSid = null; premium = false; },
  };
}
