import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubFetch, flush } from './_helpers/fetchStub.js';

vi.mock('hls.js', async () => ({ default: (await import('./_helpers/fakeHls.js')).FakeHls }));
const { FakeHls } = await import('./_helpers/fakeHls.js');
const { playLivePreroll } = await import('../../../src/livePreroll.js');
const { CAP_ID, recentAdKeys } = await import('../../../src/adBreak.js');

const SID = 'c'.repeat(32);
const MANIFEST = `https://checker.3speak.tv/m/${SID}/short.m3u8`;
const AD = { preroll: true, manifestUrl: MANIFEST, durationSeconds: 10, adKey: 'live-ad-1' };

let wrapper;
let video;
let clock;
let paused;
let hidden;

/** A <video> whose clock, paused flag and play() the test drives. */
function makeVideo() {
  const v = document.createElement('video');
  Object.defineProperty(v, 'currentTime', { configurable: true, get: () => clock, set: (t) => { clock = t; } });
  Object.defineProperty(v, 'paused', { configurable: true, get: () => paused });
  v.play = vi.fn(async () => { paused = false; });
  v.pause = vi.fn(() => { paused = true; });
  v.canPlayType = vi.fn(() => '');
  return v;
}

function checker(ad = AD) {
  return stubFetch((url) => {
    if (url.endsWith('/m/session')) return { ad };
    return { ok: true };
  });
}

const layer = () => wrapper.lastElementChild;
const text = () => layer().textContent;
const buttons = () => Array.from(layer().querySelectorAll('button'));
const skipBtn = () => buttons()[0];
const soundBtn = () => buttons()[1];
const beats = (net) => net.to('/w').map((c) => c.body.seconds);
const tick = (t) => { clock = t; video.dispatchEvent(new Event('timeupdate')); };

/** Start a pre-roll and wait until hls.js has been handed the playlist. */
async function start(ad = AD) {
  const net = checker(ad);
  const done = playLivePreroll({ wrapper, video, host: 'badadib', room: 'badadib-room' });
  await vi.waitFor(() => { if (!FakeHls.instances.length) throw new Error('not yet'); }, { interval: 1 });
  const hls = FakeHls.instances[0];
  return { net, done, hls };
}

beforeEach(() => {
  document.body.innerHTML = '<div class="player-wrapper"></div>';
  wrapper = document.querySelector('.player-wrapper');
  clock = 0;
  paused = true;
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  video = makeVideo();
  video.muted = true;
  wrapper.appendChild(video);
  FakeHls.reset();
  localStorage.clear();
});

afterEach(() => { vi.useRealTimers(); });

describe('asking for a pre-roll', () => {
  it('needs a wrapper, a video, a host and a room', async () => {
    const net = stubFetch();
    await playLivePreroll({ wrapper, video, host: 'badadib' });
    await playLivePreroll({ wrapper: null, video, host: 'badadib', room: 'r' });
    expect(net.calls).toHaveLength(0);
  });

  it('asks the checker for a live pre-roll with the shared cap id and seen list', async () => {
    const net = checker(null);
    await playLivePreroll({ wrapper, video, host: 'badadib', room: 'badadib-room' });
    const [call] = net.calls;
    expect(call.url).toBe('https://checker.3speak.tv/m/session');
    expect(call.opts.method).toBe('POST');
    expect(call.opts.signal).toBeInstanceOf(AbortSignal);
    expect(call.body).toEqual({
      surface: 'live', owner: 'badadib', permlink: 'badadib-room', viewer: null, capId: CAP_ID,
      recentAdKeys: [], preroll: true, ticker: false, bannerOverlay: true,
    });
  });

  it.each([
    ['an error status', () => new Response('', { status: 500 })],
    ['a network failure', () => new Error('offline')],
    ['no ad', () => ({})],
    ['an ad that is not a pre-roll', () => ({ ad: { ...AD, preroll: false } })],
    ['an ad without a playlist', () => ({ ad: { ...AD, manifestUrl: '' } })],
    ['a playlist without a session id', () => ({ ad: { ...AD, manifestUrl: 'https://checker.3speak.tv/m/x/short.m3u8' } })],
  ])('starts the stream at once on %s', async (_name, answer) => {
    stubFetch(answer);
    await playLivePreroll({ wrapper, video, host: 'badadib', room: 'r' });
    expect(wrapper.children).toHaveLength(1);
    expect(FakeHls.instances).toHaveLength(0);
  });

  it('gives up after 3 seconds without an answer', async () => {
    vi.useFakeTimers();
    stubFetch((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const done = playLivePreroll({ wrapper, video, host: 'badadib', room: 'r' });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(done).resolves.toBeUndefined();
    expect(FakeHls.instances).toHaveLength(0);
  });
});

describe('the pre-roll chrome', () => {
  it('covers the frame and discloses the advertiser', async () => {
    const { hls } = await start({
      ...AD, brand: { account: 'badadib', productName: 'Widget', clickUrl: 'https://widget.example', slogan: 'Best widget' },
    });
    expect(text()).toContain('Loading…');
    expect(text()).toContain('Advertisement from @badadib');
    expect(text()).toContain('Best widget');
    const link = layer().querySelector('a');
    expect(link.textContent).toBe('Widget ↗');
    expect(link.href).toBe('https://widget.example/');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer sponsored');
    hls.emit(FakeHls.Events.ERROR, { fatal: true });
  });

  it('names a product without a link, and a plain Advertisement without an account', async () => {
    const { hls } = await start({ ...AD, brand: { productName: 'Widget' } });
    expect(layer().querySelector('a')).toBeNull();
    expect(layer().querySelector('strong').textContent).toBe('Widget');
    expect(text()).toContain('Advertisement');
    expect(text()).not.toContain('from @');
    hls.emit(FakeHls.Events.ERROR, { fatal: true });
  });
});

describe('playing the pre-roll', () => {
  it('loads the playlist through hls.js and starts with sound', async () => {
    const { hls, done } = await start();
    expect(hls.config).toEqual({ enableWorker: true });
    expect(hls.loadSource).toHaveBeenCalledWith(MANIFEST);
    expect(hls.attachMedia).toHaveBeenCalledWith(video);
    expect(video.loop).toBe(false);
    hls.emit(FakeHls.Events.MANIFEST_PARSED);
    await flush();
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(false);
    expect(soundBtn().style.display).toBe('none');
    video.dispatchEvent(new Event('ended'));
    await done;
  });

  it('falls back to muted with a sound button when autoplay with sound is refused', async () => {
    const { hls, done } = await start();
    video.play.mockRejectedValueOnce(new Error('NotAllowedError'));
    hls.emit(FakeHls.Events.MANIFEST_PARSED);
    await flush(10);
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(video.muted).toBe(true);
    expect(soundBtn().style.display).toBe('inline-flex');
    soundBtn().click();
    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(3);
    expect(soundBtn().style.display).toBe('none');
    video.dispatchEvent(new Event('ended'));
    await done;
  });

  it('the sound button keeps playing muted if unmuting is refused', async () => {
    const { hls, done } = await start();
    video.play.mockRejectedValueOnce(new Error('no')).mockResolvedValueOnce().mockRejectedValueOnce(new Error('no'));
    hls.emit(FakeHls.Events.MANIFEST_PARSED);
    await flush(10);
    soundBtn().click();
    await flush();
    expect(soundBtn().style.display).toBe('none');
    video.dispatchEvent(new Event('ended'));
    await done;
  });

  it('gives up and starts the stream when even muted playback is refused', async () => {
    const { hls, done } = await start();
    video.play.mockRejectedValue(new Error('no'));
    hls.emit(FakeHls.Events.MANIFEST_PARSED);
    await done;
    expect(wrapper.lastElementChild).toBe(video);
    expect(hls.destroy).toHaveBeenCalled();
  });

  it('hides the cover once the spot is playing', async () => {
    const { done } = await start();
    const cover = layer().firstElementChild;
    expect(cover.textContent).toBe('Loading…');
    video.dispatchEvent(new Event('playing'));
    expect(cover.style.display).toBe('none');
    video.dispatchEvent(new Event('ended'));
    await done;
  });

  it('uses native HLS where hls.js is not supported', async () => {
    FakeHls.supported = false;
    video.canPlayType.mockReturnValue('maybe');
    checker();
    const done = playLivePreroll({ wrapper, video, host: 'badadib', room: 'r' });
    await vi.waitFor(() => { if (!video.play.mock.calls.length) throw new Error('not yet'); }, { interval: 1 });
    expect(video.canPlayType).toHaveBeenCalledWith('application/vnd.apple.mpegurl');
    expect(video.getAttribute('src')).toBe(MANIFEST);
    video.dispatchEvent(new Event('ended'));
    await done;
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('starts the stream at once when this browser cannot play HLS at all', async () => {
    FakeHls.supported = false;
    checker();
    await playLivePreroll({ wrapper, video, host: 'badadib', room: 'r' });
    expect(wrapper.lastElementChild).toBe(video);
  });
});

describe('the countdown and the Skip button', () => {
  it('counts down to the stream and has no Skip when the server offers none', async () => {
    const { done } = await start();
    tick(3.2);
    expect(text()).toContain('The stream starts in 7s');
    expect(skipBtn().style.display).toBe('none');
    tick(10);
    expect(text()).toContain('The stream starts in a moment');
    video.dispatchEvent(new Event('ended'));
    await done;
  });

  it('shows no countdown for a spot of unknown length', async () => {
    const { done } = await start({ ...AD, durationSeconds: undefined });
    tick(1);
    expect(text()).not.toContain('The stream starts');
    video.dispatchEvent(new Event('ended'));
    await done;
  });

  it('counts down to Skip, ignores early presses, then skips and reports it', async () => {
    const { net, done } = await start({ ...AD, skipAfterSeconds: 5 });
    tick(2);
    expect(skipBtn().style.display).toBe('inline-flex');
    expect(skipBtn().textContent).toBe('Skip in 3');
    expect(skipBtn().dataset.ready).toBe('0');
    skipBtn().click();
    expect(wrapper.contains(skipBtn())).toBe(true);
    tick(5);
    expect(skipBtn().textContent).toBe('Skip ad ⏭');
    expect(skipBtn().dataset.ready).toBe('1');
    const btn = skipBtn();
    btn.click();
    await done;
    expect(wrapper.contains(btn)).toBe(false);
    expect(net.to('/skipped').map((c) => c.url)).toEqual([`https://checker.3speak.tv/m/${SID}/skipped`]);
    expect(beats(net)).toEqual([2, 5]);
  });

  it('a failed skip report does not hold the stream back', async () => {
    const { done } = await start({ ...AD, skipAfterSeconds: 0 });
    stubFetch(() => new Error('offline'));
    tick(1);
    skipBtn().click();
    await expect(done).resolves.toBeUndefined();
  });
});

describe('reporting seconds watched', () => {
  it('beats every 2 seconds of real progress and once more at the end', async () => {
    const { net, done } = await start();
    tick(0.5);
    tick(1.9);
    expect(beats(net)).toEqual([]);
    tick(2.1);
    expect(beats(net)).toEqual([2.1]);
    tick(1.0); // a rewind adds nothing
    tick(3.9);
    expect(beats(net)).toEqual([2.1]);
    tick(4.2);
    expect(beats(net)).toEqual([2.1, 4.2]);
    video.dispatchEvent(new Event('ended'));
    await done;
    expect(beats(net)).toEqual([2.1, 4.2, 10]);
    const beat = net.to('/w')[0];
    expect(beat.url).toBe(`https://checker.3speak.tv/m/${SID}/w`);
    expect(beat.opts.keepalive).toBe(true);
  });

  it('remembers the ad as seen once it has really played', async () => {
    const { done } = await start();
    tick(0);
    expect(recentAdKeys()).toEqual([]);
    tick(0.3);
    expect(recentAdKeys()).toEqual(['live-ad-1']);
    video.dispatchEvent(new Event('ended'));
    await done;
  });

  it('sends what has played when the page goes away', async () => {
    const { net, done } = await start();
    tick(1.5);
    window.dispatchEvent(new Event('pagehide'));
    expect(beats(net)).toEqual([1.5]);
    window.dispatchEvent(new Event('pagehide'));
    expect(beats(net)).toEqual([1.5]);
    video.dispatchEvent(new Event('error'));
    await done;
  });

  it('a failed beat is not a failure', async () => {
    const { done } = await start();
    stubFetch(() => new Error('offline'));
    tick(2.5);
    await flush();
    video.dispatchEvent(new Event('ended'));
    await expect(done).resolves.toBeUndefined();
  });
});

describe('ending the pre-roll', () => {
  it('leaves the video muted, with no source, and the chrome gone', async () => {
    const { hls, done } = await start();
    video.muted = false;
    video.dispatchEvent(new Event('error'));
    await done;
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('src')).toBe(false);
    expect(video.pause).toHaveBeenCalled();
    expect(hls.destroy).toHaveBeenCalled();
    expect(wrapper.children).toHaveLength(1);
  });

  it('stops listening once finished', async () => {
    const { net, done } = await start();
    video.dispatchEvent(new Event('error'));
    await done;
    tick(5);
    window.dispatchEvent(new Event('pagehide'));
    expect(beats(net)).toEqual([]);
  });

  it('a fatal hls.js error starts the stream, a recoverable one does not', async () => {
    const { hls, done } = await start();
    let settled = false;
    done.then(() => { settled = true; });
    hls.emit(FakeHls.Events.ERROR, { fatal: false });
    hls.emit(FakeHls.Events.ERROR, null);
    await flush();
    expect(settled).toBe(false);
    hls.emit(FakeHls.Events.ERROR, { fatal: true });
    await done;
  });

  it('survives a player that throws while being reset', async () => {
    const { hls, done } = await start();
    hls.destroy.mockImplementation(() => { throw new Error('gone'); });
    video.pause.mockImplementation(() => { throw new Error('gone'); });
    video.load = () => { throw new Error('gone'); };
    video.dispatchEvent(new Event('error'));
    await expect(done).resolves.toBeUndefined();
  });
});

describe('the stall watchdog and tab visibility', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] }); });

  async function startWithTimers(ad = AD) {
    const net = checker(ad);
    const done = playLivePreroll({ wrapper, video, host: 'badadib', room: 'r' });
    await vi.advanceTimersByTimeAsync(0);
    return { net, done, hls: FakeHls.instances[0] };
  }

  it('starts the stream when playback makes no progress for 12 seconds', async () => {
    const { done } = await startWithTimers();
    paused = false;
    let settled = false;
    done.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(12000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
  });

  it('does not count progress-free time while paused or hidden', async () => {
    const { done } = await startWithTimers();
    let settled = false;
    done.then(() => { settled = true; });
    paused = true;
    await vi.advanceTimersByTimeAsync(20000);
    paused = false;
    hidden = true;
    await vi.advanceTimersByTimeAsync(20000);
    expect(settled).toBe(false);
    video.dispatchEvent(new Event('ended'));
    await done;
  });

  it('progress keeps the watchdog quiet', async () => {
    const { done } = await startWithTimers();
    paused = false;
    let settled = false;
    done.then(() => { settled = true; });
    for (let s = 1; s <= 20; s += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      tick(s * 0.4);
    }
    expect(settled).toBe(false);
    video.dispatchEvent(new Event('ended'));
    await done;
  });

  it('pauses while the tab is hidden and resumes when it comes back', async () => {
    const { done } = await startWithTimers();
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(video.pause).toHaveBeenCalled();
    hidden = false;
    video.play.mockRejectedValueOnce(new Error('needs a tap'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(video.play).toHaveBeenCalled();
    video.pause.mockImplementation(() => { throw new Error('x'); });
    hidden = true;
    expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
    video.dispatchEvent(new Event('ended'));
    await done;
  });
});
