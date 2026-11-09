import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAdBreak, AD_COUNTDOWN_FROM, AD_BILLABLE_SECONDS, AD_BASE, CAP_ID, recentAdKeys, rememberAdSeen,
} from '../../../src/adBreak.js';
import { stubFetch, flush } from './_helpers/fetchStub.js';

const SID = 'a'.repeat(32);
const BANNER_SID = 'b'.repeat(32);
const SPOT_URL = `https://checker.3speak.tv/m/${SID}.m3u8`;
const BANNER_URL = `https://checker.3speak.tv/m/${BANNER_SID}.m3u8`;
const CONTENT = 'https://cdn.example/badadib/manifest.m3u8';
const SEEN_KEY = '3speak-ads-seen';
const ASK = { owner: 'badadib', permlink: 'badadib-video', manifestUrl: CONTENT };

/** A checker that books `session` and answers /i with `info` (or a list of answers, one per poll). */
function checker({ session = {}, info = {}, onBeat } = {}) {
  const answers = Array.isArray(info) ? [...info] : null;
  return stubFetch((url, opts) => {
    if (url.endsWith('/m/session')) return session;
    if (url.endsWith('/i')) {
      if (!answers) return info;
      const next = answers.length > 1 ? answers.shift() : answers[0];
      return typeof next === 'function' ? next() : next;
    }
    if (onBeat) onBeat(url, opts);
    return { ok: true };
  });
}

/** A resolved spot of `duration` seconds at player-time `start`. */
async function spotAt(start, duration, { ad = {}, info = {}, banner } = {}) {
  const net = checker({
    session: { ad: { manifestUrl: SPOT_URL, position: start, durationSeconds: duration, ...ad }, banner },
    info: { adStartAt: start, adDurationSeconds: duration, ...info },
  });
  const ab = createAdBreak();
  await ab.request(ASK);
  await ab.resolve();
  return { ab, net };
}

/** Walk the playhead like timeupdate does: ~4 ticks a second. */
function play(ab, from, to, step = 0.25) {
  for (let t = from; t <= to + 1e-9; t += step) ab.noteTime(Math.round(t * 1000) / 1000);
}

const seenList = () => JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe('module exports', () => {
  it('talks to the production checker unless the page overrides it', () => {
    expect(AD_BASE).toBe('https://checker.3speak.tv');
  });

  it('agrees with the checker on the countdown and billing windows', () => {
    expect(AD_COUNTDOWN_FROM).toBe(3);
    expect(AD_BILLABLE_SECONDS).toBe(3);
  });

  it('has a per-page-load cap id of 24 hex characters', () => {
    expect(CAP_ID).toMatch(/^[0-9a-f]{24}$/);
  });

  it('honours window.__AD_BASE__ set before the module loads', async () => {
    vi.resetModules();
    window.__AD_BASE__ = 'http://127.0.0.1:3131';
    try {
      const mod = await import('../../../src/adBreak.js');
      expect(mod.AD_BASE).toBe('http://127.0.0.1:3131');
    } finally {
      delete window.__AD_BASE__;
    }
  });

  it('falls back to no cap id when the random source throws', async () => {
    vi.resetModules();
    vi.stubGlobal('crypto', { getRandomValues() { throw new Error('no entropy'); } });
    const mod = await import('../../../src/adBreak.js');
    expect(mod.CAP_ID).toBeNull();
  });
});

describe('the recently-seen ads list', () => {
  it('starts empty and records each key with the time it was seen', () => {
    vi.useFakeTimers({ now: new Date('2026-11-09T12:00:00Z') });
    expect(recentAdKeys()).toEqual([]);
    rememberAdSeen('ad-1', ['ad-2', '', 7, null]);
    expect(recentAdKeys().sort()).toEqual(['ad-1', 'ad-2']);
    expect(seenList()['ad-1']).toBe(Date.now());
  });

  it('ignores a call with nothing usable in it', () => {
    rememberAdSeen('', null, 3);
    expect(localStorage.getItem(SEEN_KEY)).toBeNull();
  });

  it('forgets an ad 15 minutes after it was seen', () => {
    vi.useFakeTimers({ now: new Date('2026-11-09T12:00:00Z') });
    rememberAdSeen('old');
    vi.setSystemTime(Date.now() + 14 * 60 * 1000);
    rememberAdSeen('new');
    expect(recentAdKeys().sort()).toEqual(['new', 'old']);
    vi.setSystemTime(Date.now() + 60 * 1000 + 1);
    expect(recentAdKeys()).toEqual(['new']);
  });

  it('treats unreadable storage as an empty list', () => {
    localStorage.setItem(SEEN_KEY, '{not json');
    expect(recentAdKeys()).toEqual([]);
  });

  it('never throws when storage refuses writes', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => rememberAdSeen('ad-1')).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});

describe('request(): asking whether this playback carries an ad', () => {
  it('does not ask without an owner, permlink and manifest', async () => {
    const net = stubFetch();
    const ab = createAdBreak();
    expect(await ab.request({ owner: 'badadib', permlink: 'p' })).toBeNull();
    expect(await ab.request({ owner: 'badadib', manifestUrl: CONTENT })).toBeNull();
    expect(await ab.request({ permlink: 'p', manifestUrl: CONTENT })).toBeNull();
    expect(net.calls).toHaveLength(0);
  });

  it('posts the playback, the cap id and the recently seen ads to /m/session', async () => {
    rememberAdSeen('seen-ad');
    const net = checker({ session: {} });
    await createAdBreak().request({ ...ASK, viewer: 'badadib', country: 'DE' });
    expect(net.calls).toHaveLength(1);
    const [call] = net.calls;
    expect(call.url).toBe('https://checker.3speak.tv/m/session');
    expect(call.opts.method).toBe('POST');
    expect(call.opts.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(call.body).toEqual({
      owner: 'badadib', permlink: 'badadib-video', viewer: 'badadib', country: 'DE', manifestUrl: CONTENT,
      capId: CAP_ID, bannerOverlay: false, ticker: false, recentAdKeys: ['seen-ad'],
    });
  });

  it('sends null for an anonymous viewer and only a literal true for the capability flags', async () => {
    const net = checker({ session: {} });
    await createAdBreak().request({ ...ASK, bannerOverlay: 'yes', ticker: 1 });
    expect(net.calls[0].body).toMatchObject({ viewer: null, country: null, bannerOverlay: false, ticker: false });
    await createAdBreak().request({ ...ASK, bannerOverlay: true, ticker: true });
    expect(net.calls[1].body).toMatchObject({ bannerOverlay: true, ticker: true });
  });

  it('returns null and stays inactive when the server has no ad', async () => {
    checker({ session: {} });
    const ab = createAdBreak();
    expect(await ab.request(ASK)).toBeNull();
    expect(ab.active).toBe(false);
    expect(ab.info).toBeNull();
  });

  it('treats an error status, a network failure or bad JSON as no ad', async () => {
    const ab = createAdBreak();
    stubFetch(() => new Response('nope', { status: 503 }));
    expect(await ab.request(ASK)).toBeNull();
    stubFetch(() => new Error('offline'));
    expect(await ab.request(ASK)).toBeNull();
    stubFetch(() => new Response('<html>', { status: 200 }));
    expect(await ab.request(ASK)).toBeNull();
    expect(ab.active).toBe(false);
  });

  it('marks a Pro viewer as premium', async () => {
    checker({ session: { premium: true } });
    const ab = createAdBreak();
    await ab.request(ASK);
    expect(ab.isPremiumViewer).toBe(true);
    checker({ session: { premium: 'true' } });
    await ab.request(ASK);
    expect(ab.isPremiumViewer).toBe(false);
  });

  it('returns the stitched manifest and opens a session for a spot', async () => {
    checker({ session: { ad: { manifestUrl: SPOT_URL, position: 30, durationSeconds: 15, adKey: 'spot-1' } } });
    const ab = createAdBreak();
    expect(await ab.request(ASK)).toBe(SPOT_URL);
    expect(ab.active).toBe(true);
    expect(ab.resolved).toBe(false);
    expect(ab.info).toEqual({
      sid: SID, position: 30, durationSeconds: 15, label: 'Sponsored', advertiser: null, brand: null, adKey: 'spot-1',
    });
  });

  it('keeps the label, advertiser and brand the server sends', async () => {
    const brand = { logo: 'x.png', productName: 'Widget' };
    checker({ session: { ad: { manifestUrl: SPOT_URL, label: 'Ad', advertiser: 'badadib', brand } } });
    const ab = createAdBreak();
    await ab.request(ASK);
    expect(ab.info).toMatchObject({ label: 'Ad', advertiser: 'badadib', brand });
  });

  it('refuses a spot whose manifest does not carry a session id', async () => {
    checker({ session: { ad: { manifestUrl: 'https://checker.3speak.tv/m/short.m3u8' } } });
    const ab = createAdBreak();
    expect(await ab.request(ASK)).toBeNull();
    expect(ab.active).toBe(false);
  });

  it('does not count the ad as seen just because the server picked it', async () => {
    checker({
      session: {
        ad: { manifestUrl: SPOT_URL, adKey: 'spot-1' },
        banner: { manifestUrl: BANNER_URL, adKey: 'banner-1' },
        ticker: { message: 'hi', durationSeconds: 10, adKey: 'tick-1' },
      },
    });
    await createAdBreak().request(ASK);
    expect(recentAdKeys()).toEqual([]);
  });

  describe('a banner', () => {
    it('plays the banner manifest when there is no spot', async () => {
      const overlay = { image: 'https://cdn.example/b.png' };
      checker({
        session: {
          banner: {
            manifestUrl: BANNER_URL, positionPercent: 10, durationSeconds: 8, advertiser: 'badadib',
            brand: { productName: 'Widget' }, adKey: 'banner-1', overlay, placement: { x: 5 },
          },
        },
      });
      const ab = createAdBreak();
      expect(await ab.request(ASK)).toBe(BANNER_URL);
      expect(ab.active).toBe(false);
      expect(ab.bannerInfo).toEqual({
        positionPercent: 10, durationSeconds: 8, advertiser: 'badadib', brand: { productName: 'Widget' },
        adKey: 'banner-1', overlay, placement: { x: 5 }, manifestUrl: BANNER_URL,
      });
      expect(ab.bannerOverlay).toEqual(overlay);
    });

    it('fills absent banner fields with null and has no overlay when burned in', async () => {
      checker({ session: { banner: { manifestUrl: BANNER_URL } } });
      const ab = createAdBreak();
      await ab.request(ASK);
      expect(ab.bannerInfo).toMatchObject({ advertiser: null, brand: null, adKey: null, overlay: null, placement: null });
      expect(ab.bannerOverlay).toBeNull();
    });

    it('still prefers the spot manifest when both are booked', async () => {
      checker({ session: { ad: { manifestUrl: SPOT_URL }, banner: { manifestUrl: BANNER_URL } } });
      const ab = createAdBreak();
      expect(await ab.request(ASK)).toBe(SPOT_URL);
      expect(ab.bannerInfo.manifestUrl).toBe(BANNER_URL);
    });
  });

  describe('a ticker', () => {
    it('is kept with defaults filled in, and the plain video plays', async () => {
      checker({ session: { ticker: { message: 'Buy now', durationSeconds: '12' } } });
      const ab = createAdBreak();
      expect(await ab.request(ASK)).toBeNull();
      expect(ab.tickerInfo).toEqual({
        message: 'Buy now', account: null, productName: null, clickUrl: null, shownUrl: null,
        positionPercent: 0, durationSeconds: 12, label: 'Ad', style: 'crawl', adKey: null, capMinutes: null,
      });
    });

    it('keeps every field the server sends and the hold style', async () => {
      const t = {
        message: 'Hello', account: 'badadib', productName: 'Widget', clickUrl: 'https://x.example',
        shownUrl: 'https://checker.3speak.tv/t/1/shown', positionPercent: '40', durationSeconds: 9,
        label: 'Promo', style: 'hold', adKey: 'tick-1', capMinutes: '5',
      };
      checker({ session: { ticker: t } });
      const ab = createAdBreak();
      await ab.request(ASK);
      expect(ab.tickerInfo).toEqual({ ...t, positionPercent: 40, capMinutes: 5 });
    });

    it('is dropped without a message or a positive length', async () => {
      const ab = createAdBreak();
      checker({ session: { ticker: { durationSeconds: 9 } } });
      await ab.request(ASK);
      expect(ab.tickerInfo).toBeNull();
      checker({ session: { ticker: { message: 'x', durationSeconds: 0 } } });
      await ab.request(ASK);
      expect(ab.tickerInfo).toBeNull();
    });
  });

  it('clears the previous answer before asking again', async () => {
    checker({
      session: {
        premium: true, ad: { manifestUrl: SPOT_URL }, banner: { manifestUrl: BANNER_URL },
        ticker: { message: 'x', durationSeconds: 5 },
      },
    });
    const ab = createAdBreak();
    await ab.request(ASK);
    checker({ session: {} });
    await ab.request(ASK);
    expect(ab.active).toBe(false);
    expect(ab.isPremiumViewer).toBe(false);
    expect(ab.bannerInfo).toBeNull();
    expect(ab.tickerInfo).toBeNull();
  });
});

describe('resolve(): learning where the break landed', () => {
  it('does nothing without a session', async () => {
    const net = stubFetch();
    const ab = createAdBreak();
    expect(await ab.resolve()).toBeNull();
    expect(net.calls).toHaveLength(0);
  });

  it('reads the window and the skip threshold from /m/:sid/i', async () => {
    const { ab, net } = await spotAt(33.166666, 14.7, { info: { skipAfterSeconds: 5 } });
    expect(net.to('/i').map((c) => c.url)).toEqual([`https://checker.3speak.tv/m/${SID}/i`]);
    expect(ab.resolved).toBe(true);
    expect(ab.spotStart()).toBe(33.166666);
    expect(ab.addedSeconds).toBe(14.7);
    expect(ab.skipOffered).toBe(true);
  });

  it('keeps polling every 700ms until the stitcher knows the cut', async () => {
    vi.useFakeTimers();
    const net = checker({
      session: { ad: { manifestUrl: SPOT_URL } },
      info: [{}, () => new Response('', { status: 500 }), () => new Error('reset'), { adStartAt: 10, adDurationSeconds: 5 }],
    });
    const ab = createAdBreak();
    await ab.request(ASK);
    const done = ab.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(net.to('/i')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(699);
    expect(net.to('/i')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(net.to('/i')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1400);
    expect(await done).toEqual({ start: 10, duration: 5 });
    expect(net.to('/i')).toHaveLength(4);
  });

  it('gives up after six tries and leaves the mapping as the identity', async () => {
    vi.useFakeTimers();
    const net = checker({ session: { ad: { manifestUrl: SPOT_URL } }, info: { adStartAt: 'soon' } });
    const ab = createAdBreak();
    await ab.request(ASK);
    const done = ab.resolve();
    await vi.advanceTimersByTimeAsync(6 * 700);
    expect(await done).toBeNull();
    expect(net.to('/i')).toHaveLength(6);
    expect(ab.resolved).toBe(false);
    expect(ab.contentTime(50)).toBe(50);
  });

  it('does not ask again once resolved', async () => {
    const { ab, net } = await spotAt(10, 5);
    expect(await ab.resolve()).toEqual({ start: 10, duration: 5 });
    expect(net.to('/i')).toHaveLength(1);
  });

  it('a window without a skip threshold offers no skip', async () => {
    const { ab } = await spotAt(10, 5, { info: { skipAfterSeconds: '5' } });
    expect(ab.skipOffered).toBe(false);
  });

  it('with a banner too, keeps polling until the banner window also arrives', async () => {
    vi.useFakeTimers();
    const net = checker({
      session: { ad: { manifestUrl: SPOT_URL }, banner: { manifestUrl: BANNER_URL } },
      info: [
        { adStartAt: 10, adDurationSeconds: 5 },
        { adStartAt: 99, adDurationSeconds: 1, bannerStartAt: 20, bannerDurationSeconds: 8 },
      ],
    });
    const ab = createAdBreak();
    await ab.request(ASK);
    const done = ab.resolve();
    await vi.advanceTimersByTimeAsync(700);
    expect(await done).toEqual({ start: 10, duration: 5 });
    expect(net.to('/i')).toHaveLength(2);
    // The second answer's spot window did not overwrite the first.
    expect(ab.spotStart()).toBe(10);
    expect(ab.isBannerVisible(30)).toBe(true);
  });

  it('a banner-only playback polls with the banner session id', async () => {
    const net = checker({
      session: { banner: { manifestUrl: BANNER_URL } },
      info: { bannerStartAt: 20, bannerDurationSeconds: 8 },
    });
    const ab = createAdBreak();
    await ab.request(ASK);
    expect(await ab.resolve()).toBeNull();
    expect(net.to('/i')[0].url).toBe(`https://checker.3speak.tv/m/${BANNER_SID}/i`);
    expect(ab.resolved).toBe(false);
    expect(ab.isBannerVisible(21)).toBe(true);
  });
});

describe('mapping player time to content time', () => {
  it('is the identity before the window is known', async () => {
    checker({ session: { ad: { manifestUrl: SPOT_URL } } });
    const ab = createAdBreak();
    await ab.request(ASK);
    expect(ab.contentTime(50)).toBe(50);
    expect(ab.playerTimeFor(50)).toBe(50);
    expect(ab.contentDuration(120)).toBe(120);
    expect(ab.isInside(50)).toBe(false);
    expect(ab.addedSeconds).toBe(0);
    expect(ab.endOfBreak()).toBeNull();
    expect(ab.spotStart()).toBeNull();
  });

  describe('with a 14.7s spot cut in at 33.17s', () => {
    let ab;
    beforeEach(async () => { ({ ab } = await spotAt(33.166666, 14.7)); });

    it('leaves time before the cut alone', () => {
      expect(ab.contentTime(10)).toBe(10);
      expect(ab.contentTime(33.166666)).toBeCloseTo(33.166666);
    });

    it('pins content time to the cut for the whole break', () => {
      expect(ab.contentTime(40)).toBeCloseTo(33.166666);
      expect(ab.contentTime(47.8)).toBeCloseTo(33.166666);
    });

    it('subtracts the ad after the break', () => {
      expect(ab.contentTime(50)).toBeCloseTo(35.3);
      expect(ab.contentTime(110 + 14.7)).toBeCloseTo(110);
    });

    it('maps content time back, keeping the cut second on the ad side', () => {
      expect(ab.playerTimeFor(10)).toBe(10);
      expect(ab.playerTimeFor(33.166666)).toBeCloseTo(33.166666);
      expect(ab.playerTimeFor(40)).toBeCloseTo(54.7);
      expect(ab.contentTime(ab.playerTimeFor(80))).toBeCloseTo(80);
    });

    it('never lands a content second inside the ad except the cut itself', () => {
      const inside = [...Array(400)].map((_, i) => ab.playerTimeFor((i / 400) * 110))
        .filter((t) => ab.spansSpot(t) && Math.abs(t - 33.166666) > 1e-9);
      expect(inside).toEqual([]);
    });

    it('takes the ad out of the duration, never below zero', () => {
      expect(ab.contentDuration(124.7)).toBeCloseTo(110);
      expect(ab.contentDuration(5)).toBe(0);
      expect(ab.addedSeconds).toBe(14.7);
    });

    it('says when the playhead is inside the break', () => {
      expect(ab.isInside(20)).toBe(false);
      expect(ab.isInside(40)).toBe(true);
      expect(ab.isInside(48.1)).toBe(false);
    });

    it('counts down to the content resuming only inside the break', () => {
      expect(ab.secondsRemaining(20)).toBeNull();
      expect(ab.secondsRemaining(40)).toBeCloseTo(7.866666);
      expect(ab.secondsRemaining(47.866666)).toBeNull();
    });

    it('lands a hair past the end of the break', () => {
      expect(ab.endOfBreak()).toBeCloseTo(33.166666 + 14.7 + 0.35);
    });

    it('passes non-finite times through untouched', () => {
      expect(ab.contentTime(NaN)).toBeNaN();
      expect(ab.playerTimeFor(Infinity)).toBe(Infinity);
      expect(ab.contentDuration(Infinity)).toBe(Infinity);
      expect(ab.isInside(NaN)).toBe(false);
      expect(ab.spansSpot(NaN)).toBe(false);
      expect(ab.secondsRemaining(NaN)).toBeNull();
      expect(ab.secondsUntil(NaN)).toBeNull();
    });
  });
});

describe('the countdown and the seek lock', () => {
  describe('a mid-roll at 60..70', () => {
    let ab;
    beforeEach(async () => { ({ ab } = await spotAt(60, 10)); });

    it('shows no hint and locks nothing far from the cut', () => {
      expect(ab.secondsUntil(20)).toBe(40);
      expect(ab.countdownAt(20)).toBeNull();
      expect(ab.seekLocked(20)).toBe(false);
    });

    it('still lets a long drag past an unwarned break through', () => {
      expect(ab.lockedSeekTarget(90, 20)).toBeNull();
    });

    it('counts whole seconds down from 3, never showing 0', () => {
      expect(ab.countdownAt(57)).toBe(3);
      expect(ab.countdownAt(57.2)).toBe(3);
      expect(ab.countdownAt(58.5)).toBe(2);
      expect(ab.countdownAt(59.99)).toBe(1);
      expect(ab.countdownAt(60)).toBeNull();
    });

    it('arms the lock once the hint is shown, and refuses forward jumps', () => {
      expect(ab.countdownAt(57.2)).toBe(3);
      expect(ab.seekLocked(57.2)).toBe(true);
      expect(ab.lockedSeekTarget(95, 57.2)).toBe(57.2);
      expect(ab.lockedSeekTarget(70.4, 58)).toBe(58);
    });

    it('always allows rewinding out of the countdown', () => {
      ab.countdownAt(58);
      expect(ab.lockedSeekTarget(10, 58)).toBeNull();
      expect(ab.lockedSeekTarget(59, 58)).toBeNull();
    });

    it('stays locked inside the spot, both within it and out of it', () => {
      ab.countdownAt(58);
      ab.noteTime(62);
      expect(ab.seekLocked(62)).toBe(true);
      expect(ab.lockedSeekTarget(68, 62)).toBe(62);
      expect(ab.lockedSeekTarget(120, 62)).toBe(62);
      expect(ab.lockedSeekTarget(61, 62)).toBeNull();
    });

    it('lets go once the spot has been watched through', () => {
      ab.countdownAt(58);
      ab.noteTime(62);
      ab.noteTime(70.5);
      expect(ab.spotConsumed).toBe(true);
      expect(ab.seekLocked(71)).toBe(false);
      expect(ab.lockedSeekTarget(200, 71)).toBeNull();
      expect(ab.secondsUntil(57.2)).toBeNull();
      expect(ab.countdownAt(57.2)).toBeNull();
    });

    it('cannot tell a frame of playback from a seek, so the caller must only ask about seeks', () => {
      ab.countdownAt(57.5);
      expect(ab.lockedSeekTarget(60.02, 59.98)).toBe(59.98);
    });

    it('ignores non-finite positions', () => {
      ab.countdownAt(58);
      expect(ab.seekLocked(NaN)).toBe(false);
      expect(ab.lockedSeekTarget(NaN, 58)).toBeNull();
      expect(ab.lockedSeekTarget(90, NaN)).toBeNull();
    });
  });

  it('a pre-roll never counts down, so a ?t= deep link is not refused', async () => {
    const { ab } = await spotAt(0, 8);
    expect(ab.countdownAt(0)).toBeNull();
    expect(ab.seekLocked(0)).toBe(false);
    expect(ab.lockedSeekTarget(120, 0)).toBeNull();
  });

  it('a playback with no spot locks nothing', () => {
    const ab = createAdBreak();
    expect(ab.seekLocked(10)).toBe(false);
    expect(ab.lockedSeekTarget(200, 10)).toBeNull();
    expect(ab.countdownAt(10)).toBeNull();
  });
});

describe('measuring seconds of the spot watched, and the billing beats', () => {
  const beats = (net) => net.to('/w').map((c) => c.body.seconds);

  it('counts nothing before the cut and bills once at 3 seconds', async () => {
    const { ab, net } = await spotAt(60, 29);
    play(ab, 57, 59.75);
    expect(ab.watchedSeconds).toBe(0);
    play(ab, 60, 62);
    expect(ab.watchedSeconds).toBeCloseTo(2);
    expect(beats(net)).toEqual([]);
    play(ab, 62.25, 64);
    expect(ab.watchedSeconds).toBeCloseTo(4);
    expect(beats(net)).toEqual([3]);
    const [beat] = net.to('/w');
    expect(beat.url).toBe(`https://checker.3speak.tv/m/${SID}/w`);
    expect(beat.opts).toMatchObject({ method: 'POST', keepalive: true });
  });

  it('sends a closing beat with the full figure on the way out', async () => {
    const { ab, net } = await spotAt(60, 29);
    play(ab, 60, 92);
    expect(beats(net)).toHaveLength(2);
    expect(beats(net)[1]).toBeCloseTo(29, 0);
    expect(ab.spotConsumed).toBe(true);
  });

  it('bills a viewer who leaves after five seconds', async () => {
    const { ab, net } = await spotAt(60, 29);
    play(ab, 60, 65);
    expect(ab.watchedSeconds).toBeCloseTo(5);
    expect(beats(net)).toEqual([3]);
  });

  it('a pause accrues nothing', async () => {
    const { ab, net } = await spotAt(60, 29);
    play(ab, 60, 62);
    for (let i = 0; i < 40; i += 1) ab.noteTime(62);
    expect(ab.watchedSeconds).toBeCloseTo(2);
    expect(beats(net)).toEqual([]);
  });

  it('jumps and rewinds are not watch time', async () => {
    const { ab } = await spotAt(60, 29);
    ab.noteTime(60);
    ab.noteTime(88);
    expect(ab.watchedSeconds).toBe(0);
    ab.noteTime(88.25);
    expect(ab.watchedSeconds).toBe(0.25);
    ab.noteTime(62);
    expect(ab.watchedSeconds).toBe(0.25);
  });

  it('leaving without having watched anything sends no closing beat', async () => {
    const { ab, net } = await spotAt(60, 29);
    ab.noteTime(61);
    ab.noteTime(95);
    expect(beats(net)).toEqual([]);
  });

  it('measures nothing on a playback with no spot', () => {
    const ab = createAdBreak();
    ab.noteTime(10);
    ab.noteTime(11);
    expect(ab.watchedSeconds).toBe(0);
  });

  it('reportWatched() does nothing without a session or watched seconds', async () => {
    const net = stubFetch();
    createAdBreak().reportWatched();
    const { ab, net: net2 } = await spotAt(60, 29);
    ab.reportWatched();
    expect(net.calls).toHaveLength(0);
    expect(net2.to('/w')).toHaveLength(0);
  });

  it('a beat that fails, even synchronously, never throws into playback', async () => {
    const { ab } = await spotAt(60, 29);
    play(ab, 60, 61);
    vi.stubGlobal('fetch', () => { throw new Error('blocked'); });
    expect(() => ab.reportWatched()).not.toThrow();
    stubFetch(() => new Error('offline'));
    expect(() => ab.reportWatched()).not.toThrow();
    await flush();
  });

  it('remembers the spot as seen the first time it is on screen', async () => {
    const { ab } = await spotAt(60, 10, { ad: { adKey: 'spot-1' } });
    ab.noteTime(30);
    expect(recentAdKeys()).toEqual([]);
    ab.noteTime(61);
    expect(recentAdKeys()).toEqual(['spot-1']);
    const first = seenList()['spot-1'];
    ab.noteTime(62);
    expect(seenList()['spot-1']).toBe(first);
  });
});

describe('a spent spot is a hole in the timeline', () => {
  it('is never skipped before it has run', async () => {
    const { ab } = await spotAt(60, 10);
    expect(ab.skipTargetFor(65, 0)).toBeNull();
  });

  it('is not spent by dragging straight past it', async () => {
    const { ab } = await spotAt(60, 10);
    ab.noteTime(20);
    ab.noteTime(90);
    expect(ab.spotConsumed).toBe(false);
  });

  describe('a mid-roll at 60..70 that has been watched', () => {
    let ab;
    beforeEach(async () => {
      ({ ab } = await spotAt(60, 10));
      ab.noteTime(65);
      ab.noteTime(71);
    });

    it('is spent', () => { expect(ab.spotConsumed).toBe(true); });

    it('throws a forward arrival to the far side', () => {
      expect(ab.skipTargetFor(65, 0)).toBeCloseTo(70.35);
      expect(ab.skipTargetFor(60.1, 59.8)).toBeCloseTo(70.35);
      expect(ab.skipTargetFor(65, NaN)).toBeCloseTo(70.35);
    });

    it('puts a viewer scrubbing back in front of it', () => {
      expect(ab.skipTargetFor(65, 90)).toBeCloseTo(59.95);
    });

    it('leaves positions outside it alone', () => {
      expect(ab.skipTargetFor(75, 0)).toBeNull();
      expect(ab.skipTargetFor(59.5, 0)).toBeNull();
    });
  });

  it('a spent pre-roll sends a backwards scrub past it in one seek', async () => {
    const { ab } = await spotAt(0, 8);
    ab.noteTime(4);
    ab.noteTime(9);
    expect(ab.skipTargetFor(4, 30)).toBeCloseTo(8.35);
  });
});

describe('skipping a spot', () => {
  it('offers no skip unless the server set a threshold', async () => {
    const { ab } = await spotAt(60, 10);
    expect(ab.skipOffered).toBe(false);
    expect(ab.canSkip(68)).toBe(false);
    expect(ab.secondsUntilSkip(61)).toBeNull();
  });

  it('allows a skip from the threshold until the end of the spot', async () => {
    const { ab } = await spotAt(60, 10, { info: { skipAfterSeconds: 5 } });
    expect(ab.canSkip(64.9)).toBe(false);
    expect(ab.canSkip(65)).toBe(true);
    expect(ab.canSkip(70)).toBe(false);
    expect(ab.canSkip(NaN)).toBe(false);
    expect(ab.secondsUntilSkip(62)).toBe(3);
    expect(ab.secondsUntilSkip(66)).toBeNull();
    expect(ab.secondsUntilSkip(NaN)).toBeNull();
  });

  it('recordSkip() spends the spot and tells the server', async () => {
    const { ab, net } = await spotAt(60, 10, { info: { skipAfterSeconds: 5 } });
    ab.recordSkip();
    expect(ab.spotConsumed).toBe(true);
    const [call] = net.to('/skipped');
    expect(call.url).toBe(`https://checker.3speak.tv/m/${SID}/skipped`);
    expect(call.opts).toMatchObject({ method: 'POST', body: '{}', keepalive: true });
  });

  it('recordSkip() with no session still spends locally and sends nothing', () => {
    const net = stubFetch();
    const ab = createAdBreak();
    ab.recordSkip();
    expect(ab.spotConsumed).toBe(true);
    expect(net.calls).toHaveLength(0);
  });

  it('swallows a failed skip report', async () => {
    const { ab } = await spotAt(60, 10);
    stubFetch(() => new Error('offline'));
    ab.recordSkip();
    await flush();
    expect(ab.spotConsumed).toBe(true);
  });
});

describe('retiring a spot', () => {
  it('silences its chrome but still knows which seconds are the ad', async () => {
    const { ab } = await spotAt(0, 8, { info: { skipAfterSeconds: 2 } });
    expect(ab.isInside(4)).toBe(true);
    expect(ab.canSkip(4)).toBe(true);
    ab.retireSpot();
    expect(ab.spotRetired).toBe(true);
    expect(ab.isInside(4)).toBe(false);
    expect(ab.canSkip(4)).toBe(false);
    expect(ab.spansSpot(4)).toBe(true);
  });
});

describe('a banner', () => {
  async function bannerAt(start, duration, { spot, adKey = 'banner-1', overlay } = {}) {
    const session = { banner: { manifestUrl: BANNER_URL, adKey, overlay } };
    const info = { bannerStartAt: start, bannerDurationSeconds: duration };
    if (spot) {
      session.ad = { manifestUrl: SPOT_URL };
      Object.assign(info, { adStartAt: spot[0], adDurationSeconds: spot[1] });
    }
    const net = checker({ session, info });
    const ab = createAdBreak();
    await ab.request(ASK);
    await ab.resolve();
    return { ab, net };
  }

  it('is visible inside its window, measured in content time', async () => {
    const { ab } = await bannerAt(20, 8, { spot: [10, 5] });
    // Content 20..28 is player 25..33 with the 5s spot in front of it.
    expect(ab.isBannerVisible(24.9)).toBe(false);
    expect(ab.isBannerVisible(25)).toBe(true);
    expect(ab.isBannerVisible(32.9)).toBe(true);
    expect(ab.isBannerVisible(33)).toBe(false);
    expect(ab.isBannerVisible(NaN)).toBe(false);
  });

  it('is never visible while the spot plays', async () => {
    const { ab } = await bannerAt(10, 8, { spot: [10, 5] });
    expect(ab.isBannerVisible(12)).toBe(false);
    expect(ab.isBannerVisible(15)).toBe(true);
  });

  it('cannot be closed for its first 5 seconds', async () => {
    const { ab } = await bannerAt(20, 10);
    expect(ab.bannerClosable(24.9)).toBe(false);
    expect(ab.bannerClosable(25)).toBe(true);
    expect(ab.bannerClosable(NaN)).toBe(false);
  });

  it('is due within a lead time before it starts, and while it shows', async () => {
    const { ab } = await bannerAt(20, 8);
    expect(ab.bannerDueWithin(15, 4)).toBe(false);
    expect(ab.bannerDueWithin(16, 4)).toBe(true);
    expect(ab.bannerDueWithin(19, 0)).toBe(false);
    expect(ab.bannerDueWithin(19)).toBe(false);
    expect(ab.bannerDueWithin(27.9)).toBe(true);
    expect(ab.bannerDueWithin(28)).toBe(false);
    expect(ab.bannerDueWithin(NaN, 4)).toBe(false);
  });

  it('answers false everywhere before its window is known', () => {
    const ab = createAdBreak();
    expect(ab.isBannerVisible(1)).toBe(false);
    expect(ab.bannerClosable(1)).toBe(false);
    expect(ab.bannerDueWithin(1, 10)).toBe(false);
  });

  it('is remembered as seen the first time it is actually on screen', async () => {
    const { ab } = await bannerAt(20, 8);
    ab.noteTime(5);
    expect(recentAdKeys()).toEqual([]);
    ab.noteTime(21);
    expect(recentAdKeys()).toEqual(['banner-1']);
  });

  it('reportBannerShown() posts to the banner session', async () => {
    const { ab, net } = await bannerAt(20, 8);
    ab.reportBannerShown();
    const [call] = net.to('/banner-shown');
    expect(call.url).toBe(`https://checker.3speak.tv/m/${BANNER_SID}/banner-shown`);
    expect(call.opts).toMatchObject({ method: 'POST', body: '{}', keepalive: true });
  });

  it('reportBannerShown() uses the spot session when there is one', async () => {
    const { ab, net } = await bannerAt(20, 8, { spot: [10, 5] });
    ab.reportBannerShown();
    expect(net.to('/banner-shown')[0].url).toBe(`https://checker.3speak.tv/m/${SID}/banner-shown`);
  });

  it('reportBannerShown() without any session sends nothing', () => {
    const net = stubFetch();
    createAdBreak().reportBannerShown();
    expect(net.calls).toHaveLength(0);
  });

  it('reportBannerShown() swallows a failure', async () => {
    const { ab } = await bannerAt(20, 8);
    stubFetch(() => new Error('offline'));
    expect(() => ab.reportBannerShown()).not.toThrow();
    await flush();
  });

  it('dismissBanner() hides it at once and returns the request to wait on', async () => {
    const { ab, net } = await bannerAt(20, 8);
    const pending = ab.dismissBanner();
    expect(ab.bannerInfo).toBeNull();
    expect(ab.isBannerVisible(21)).toBe(false);
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(net.to('/dismiss')[0].url).toBe(`https://checker.3speak.tv/m/${BANNER_SID}/dismiss`);
  });

  it('dismissBanner() resolves even when the server cannot be reached', async () => {
    const { ab } = await bannerAt(20, 8);
    stubFetch(() => new Error('offline'));
    await expect(ab.dismissBanner()).resolves.toBeUndefined();
  });

  it('dismissBanner() with no session resolves without a request', async () => {
    const net = stubFetch();
    await expect(createAdBreak().dismissBanner()).resolves.toBeUndefined();
    expect(net.calls).toHaveLength(0);
  });
});

describe('a ticker', () => {
  async function tickerOn(ticker, spot) {
    const session = { ticker: { message: 'Buy now', durationSeconds: 10, ...ticker } };
    if (spot) session.ad = { manifestUrl: SPOT_URL };
    const net = checker({ session, info: spot ? { adStartAt: spot[0], adDurationSeconds: spot[1] } : {} });
    const ab = createAdBreak();
    await ab.request(ASK);
    if (spot) await ab.resolve();
    return { ab, net };
  }

  it('crawls at its percentage of the content for its length', async () => {
    const { ab } = await tickerOn({ positionPercent: 50 });
    expect(ab.isTickerVisible(49.9, 100)).toBe(false);
    expect(ab.isTickerVisible(50, 100)).toBe(true);
    expect(ab.isTickerVisible(59.9, 100)).toBe(true);
    expect(ab.isTickerVisible(60, 100)).toBe(false);
  });

  it('measures against the content, not the stitched file, and hides during the spot', async () => {
    const { ab } = await tickerOn({ positionPercent: 50 }, [0, 20]);
    // 120s file = 100s of content behind a 20s pre-roll.
    expect(ab.isTickerVisible(10, 120)).toBe(false);
    expect(ab.isTickerVisible(69.9, 120)).toBe(false);
    expect(ab.isTickerVisible(70, 120)).toBe(true);
  });

  it('is never visible without a usable clock', async () => {
    const { ab } = await tickerOn({});
    expect(ab.isTickerVisible(NaN, 100)).toBe(false);
    expect(ab.isTickerVisible(1, Infinity)).toBe(false);
    expect(ab.isTickerVisible(1, 0)).toBe(false);
    expect(createAdBreak().isTickerVisible(1, 100)).toBe(false);
  });

  it('tickerWatched() reports once and remembers it for its own cap window', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-09T12:00:00Z') });
    const shownUrl = 'https://checker.3speak.tv/t/xyz/shown';
    const { ab, net } = await tickerOn({ shownUrl, adKey: 'tick-1', capMinutes: 5 });
    ab.tickerWatched();
    ab.tickerWatched();
    expect(net.to('/shown')).toHaveLength(1);
    expect(net.to('/shown')[0].opts).toMatchObject({ method: 'POST', body: '{}', keepalive: true });
    // Dated back 10 minutes so it falls out after 5.
    expect(seenList()['tick-1']).toBe(Date.now() - 10 * 60 * 1000);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 - 1);
    expect(recentAdKeys()).toEqual(['tick-1']);
    vi.setSystemTime(Date.now() + 2);
    expect(recentAdKeys()).toEqual([]);
  });

  it('a cap at or past the list window is remembered for the full 15 minutes', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-09T12:00:00Z') });
    const { ab } = await tickerOn({ adKey: 'tick-1', capMinutes: 30 });
    ab.tickerWatched();
    expect(seenList()['tick-1']).toBe(Date.now());
  });

  it('remembers it without reporting when there is no shown URL', async () => {
    const { ab, net } = await tickerOn({ adKey: 'tick-1' });
    ab.tickerWatched();
    expect(recentAdKeys()).toEqual(['tick-1']);
    expect(net.calls).toHaveLength(1);
  });

  it('survives storage that refuses writes', async () => {
    const { ab } = await tickerOn({ adKey: 'tick-1', capMinutes: 5 });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => ab.tickerWatched()).not.toThrow();
  });

  it('swallows a failed impression report', async () => {
    const { ab } = await tickerOn({ shownUrl: 'https://checker.3speak.tv/t/x/shown' });
    stubFetch(() => new Error('offline'));
    expect(() => ab.tickerWatched()).not.toThrow();
    await flush();
  });

  it('tickerWatched() with no ticker does nothing', () => {
    const net = stubFetch();
    createAdBreak().tickerWatched();
    expect(net.calls).toHaveLength(0);
  });
});

describe('reset()', () => {
  it('forgets every placement and every piece of progress', async () => {
    const net = checker({
      session: {
        premium: true, ad: { manifestUrl: SPOT_URL }, banner: { manifestUrl: BANNER_URL },
        ticker: { message: 'x', durationSeconds: 5 },
      },
      info: { adStartAt: 10, adDurationSeconds: 5, skipAfterSeconds: 2, bannerStartAt: 20, bannerDurationSeconds: 5 },
    });
    const ab = createAdBreak();
    await ab.request(ASK);
    await ab.resolve();
    play(ab, 10, 13);
    ab.countdownAt(8);
    ab.retireSpot();
    ab.recordSkip();
    ab.reset();
    expect(ab.active).toBe(false);
    expect(ab.resolved).toBe(false);
    expect(ab.isPremiumViewer).toBe(false);
    expect(ab.bannerInfo).toBeNull();
    expect(ab.tickerInfo).toBeNull();
    expect(ab.spotRetired).toBe(false);
    expect(ab.spotConsumed).toBe(false);
    expect(ab.skipOffered).toBe(false);
    expect(ab.watchedSeconds).toBe(0);
    const before = net.calls.length;
    expect(await ab.resolve()).toBeNull();
    expect(net.calls).toHaveLength(before);
  });
});
