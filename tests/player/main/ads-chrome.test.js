import './_helpers/mocks.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boot, cleanup, stubProp } from './_helpers/boot.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const q = (player, sel) => player.el().querySelector(sel);

async function withSpot(info, extra) {
  const ctx = await boot();
  const { ab, player } = ctx;
  ab.active = true;
  ab.resolved = true;
  ab.info = info;
  Object.assign(ab, extra || {});
  player.s.paused = false;
  return ctx;
}

const BRAND = {
  sid: 'spot-1',
  brand: { clickUrl: 'https://checker.3speak.tv/c/spot-1', productName: 'Badadib Beans', logoUrl: 'https://img/logo.png', slogan: 'Fresh daily' },
};

describe('sponsor disclosure', () => {
  it('is drawn over the spot as a link, with a countdown, and hidden after it', async () => {
    const { player, ab } = await withSpot(BRAND);
    ab.isInside.mockReturnValue(true);
    ab.secondsRemaining.mockReturnValue(4.2);
    player.tick(12);
    const note = q(player, '.vjs-sponsor-note');
    expect(note.tagName).toBe('A');
    expect(note.classList.contains('vjs-sponsor-link')).toBe(true);
    expect(note.getAttribute('href')).toBe('https://checker.3speak.tv/c/spot-1');
    expect(note.target).toBe('_blank');
    expect(note.rel).toBe('noopener noreferrer');
    expect(note.getAttribute('aria-label')).toBe("Open Badadib Beans's website in a new tab");
    expect(note.querySelector('img.vjs-sponsor-logo').getAttribute('src')).toBe('https://img/logo.png');
    expect(note.querySelector('.vjs-sponsor-from').textContent).toBe('Ad');
    expect(note.querySelector('.vjs-sponsor-name').textContent).toBe('Badadib Beans');
    const slogan = note.querySelector('.vjs-sponsor-slogan');
    expect(slogan.classList.contains('vjs-sponsor-slogan-scroll')).toBe(false);
    expect(slogan.children).toHaveLength(1);
    expect(note.querySelector('.vjs-sponsor-resume').textContent).toBe('Video continues in 5s');
    expect(note.style.display).toBe('flex');
    expect(note.classList.contains('vjs-sponsor-compact')).toBe(false);
    expect(player.el().classList.contains('vjs-roll-playing')).toBe(true);

    // Clicking it never reaches the player surface.
    const surface = vi.fn();
    player.el().addEventListener('click', surface);
    note.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(surface).not.toHaveBeenCalled();

    ab.secondsRemaining.mockReturnValue(0);
    player.tick(16);
    expect(note.querySelector('.vjs-sponsor-resume').textContent).toBe('Video continues in a moment');
    ab.secondsRemaining.mockReturnValue(null);
    player.tick(16.5);
    expect(note.querySelector('.vjs-sponsor-resume').textContent).toBe('');
    // Same spot: updated in place, never duplicated.
    expect(player.el().querySelectorAll('.vjs-sponsor-note')).toHaveLength(1);

    ab.isInside.mockReturnValue(false);
    player.tick(30);
    expect(note.style.display).toBe('none');
    expect(player.el().classList.contains('vjs-roll-playing')).toBe(false);
  });

  it('is a plain div without a click URL, with a placeholder logo and a scrolling long slogan', async () => {
    const long = 'The longest slogan Badadib ever wrote for a bean';
    const { player, ab } = await withSpot({ sid: 's2', brand: { slogan: long } });
    ab.isInside.mockReturnValue(true);
    player.tick(1);
    const note = q(player, '.vjs-sponsor-note');
    expect(note.tagName).toBe('DIV');
    expect(note.querySelector('span.vjs-sponsor-logo')).not.toBeNull();
    expect(note.querySelector('.vjs-sponsor-name')).toBeNull();
    const slogan = note.querySelector('.vjs-sponsor-slogan');
    expect(slogan.classList.contains('vjs-sponsor-slogan-scroll')).toBe(true);
    const texts = slogan.querySelectorAll('.vjs-sponsor-slogan-text');
    expect(texts).toHaveLength(2);
    expect(texts[1].getAttribute('aria-hidden')).toBe('true');
  });

  it('a link with no product name gets a generic label', async () => {
    const { player, ab } = await withSpot({ sid: 's3', brand: { clickUrl: 'https://c/x' } });
    ab.isInside.mockReturnValue(true);
    player.tick(1);
    expect(q(player, '.vjs-sponsor-note').getAttribute('aria-label')).toBe("Open the advertiser's website in a new tab");
  });

  it('is rebuilt for a new spot and survives missing info', async () => {
    const { player, ab } = await withSpot(BRAND);
    ab.isInside.mockReturnValue(true);
    player.tick(1);
    ab.info = null;
    player.tick(2);
    const notes = player.el().querySelectorAll('.vjs-sponsor-note');
    expect(notes).toHaveLength(1);
    expect(notes[0].tagName).toBe('DIV');
  });

  it('collapses to one line on a small player', async () => {
    const { player, ab } = await withSpot(BRAND);
    ab.isInside.mockReturnValue(true);
    player.el().getBoundingClientRect = () => ({ width: 320, height: 180 });
    player.tick(1);
    expect(q(player, '.vjs-sponsor-note').classList.contains('vjs-sponsor-compact')).toBe(true);
    player.el().getBoundingClientRect = () => { throw new Error('detached'); };
    player.tick(2);
    expect(q(player, '.vjs-sponsor-note').classList.contains('vjs-sponsor-compact')).toBe(false);
  });

  it('a non-finite clock counts as zero', async () => {
    const { player, ab } = await withSpot(BRAND);
    ab.isInside.mockReturnValue(true);
    ab.secondsRemaining.mockReturnValue(2);
    player.tick(NaN);
    expect(ab.secondsRemaining).toHaveBeenCalledWith(0);
  });

  it('no spot, no chrome', async () => {
    const { player, ab } = await boot();
    player.tick(5);
    expect(q(player, '.vjs-sponsor-note')).toBeNull();
    expect(ab.isInside).not.toHaveBeenCalledWith(5);
  });
});

describe('countdown, imminent lock and skip', () => {
  it('"Ad in N" counts down before the spot and dims the scrubber', async () => {
    const { player, ab } = await withSpot(BRAND);
    ab.countdownAt.mockReturnValue(3);
    ab.seekLocked.mockReturnValue(true);
    player.tick(27);
    const cd = q(player, '.vjs-ad-countdown');
    expect(cd.textContent).toBe('Ad in 3');
    expect(cd.style.display).toBe('block');
    expect(player.el().classList.contains('vjs-roll-imminent')).toBe(true);
    ab.countdownAt.mockReturnValue(1);
    player.tick(29);
    expect(cd.textContent).toBe('Ad in 1');
    ab.countdownAt.mockReturnValue(null);
    ab.seekLocked.mockReturnValue(false);
    player.tick(29.9);
    expect(cd.style.display).toBe('none');
    expect(player.el().classList.contains('vjs-roll-imminent')).toBe(false);
  });

  it('the skip button waits, then skips to the end of the break', async () => {
    const { player, ab } = await withSpot(BRAND, { skipOffered: true });
    ab.isInside.mockReturnValue(true);
    ab.secondsUntilSkip.mockReturnValue(2.3);
    ab.endOfBreak.mockReturnValue(45);
    player.tick(31);
    const skip = q(player, '.vjs-ad-skip');
    expect(skip.tagName).toBe('BUTTON');
    expect(skip.textContent).toBe('Skip in 3');
    expect(skip.className).toBe('vjs-ad-skip vjs-ad-skip-waiting');
    expect(skip.dataset.ready).toBe('0');
    expect(skip.style.display).toBe('inline-flex');
    skip.click();
    expect(ab.recordSkip).not.toHaveBeenCalled();

    ab.canSkip.mockReturnValue(true);
    player.tick(34);
    expect(skip.textContent).toBe('Skip ad');
    expect(skip.className).toBe('vjs-ad-skip vjs-ad-skip-ready');
    const surface = vi.fn();
    player.el().addEventListener('click', surface);
    skip.click();
    expect(ab.recordSkip).toHaveBeenCalledTimes(1);
    expect(player.currentTime).toHaveBeenLastCalledWith(45);
    expect(surface).not.toHaveBeenCalled();

    ab.isInside.mockReturnValue(false);
    player.tick(46);
    expect(skip.style.display).toBe('none');
  });

  it('skip still seeks when recording fails, and stays put without an end', async () => {
    const { player, ab } = await withSpot(BRAND, { skipOffered: true });
    ab.isInside.mockReturnValue(true);
    ab.canSkip.mockReturnValue(true);
    ab.recordSkip.mockImplementation(() => { throw new Error('offline'); });
    ab.endOfBreak.mockReturnValue(40);
    player.tick(31);
    q(player, '.vjs-ad-skip').click();
    expect(player.currentTime).toHaveBeenLastCalledWith(40);
    ab.endOfBreak.mockReturnValue(NaN);
    player.currentTime.mockClear();
    q(player, '.vjs-ad-skip').click();
    expect(player.currentTime).not.toHaveBeenCalledWith(expect.anything());
  });

  it('a seek that throws during skip is swallowed', async () => {
    const { player, ab } = await withSpot(BRAND, { skipOffered: true });
    ab.isInside.mockReturnValue(true);
    ab.canSkip.mockReturnValue(true);
    ab.endOfBreak.mockReturnValue(40);
    player.tick(31);
    player.currentTime.mockImplementation((v) => { if (v !== undefined) throw new Error('seek'); return 31; });
    expect(() => q(player, '.vjs-ad-skip').click()).not.toThrow();
  });

  it('the skip button sits in the corner unless the control bar is on screen', async () => {
    const { player, ab } = await withSpot(BRAND, { skipOffered: true });
    ab.isInside.mockReturnValue(true);
    const bar = q(player, '.vjs-control-bar');
    bar.getBoundingClientRect = () => ({ height: 30 });
    player.tick(31);
    expect(q(player, '.vjs-ad-skip').style.bottom).toBe('38px');
    bar.style.opacity = '0';
    player.tick(31.5);
    expect(q(player, '.vjs-ad-skip').style.bottom).toBe('12px');
    bar.remove();
    player.tick(32);
    expect(q(player, '.vjs-ad-skip').style.bottom).toBe('12px');
  });

  it('no skip button when the spot offers none', async () => {
    const { player, ab } = await withSpot(BRAND);
    ab.isInside.mockReturnValue(true);
    player.tick(31);
    expect(q(player, '.vjs-ad-skip')).toBeNull();
  });
});

describe('keyboard seek lock', () => {
  const key = (k) => {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  it('blocks only the seeking keys while a spot or its countdown is on', async () => {
    const { ab } = await withSpot(BRAND);
    expect(key('ArrowRight')).toBe(false);
    ab.isInside.mockReturnValue(true);
    expect(key('ArrowRight')).toBe(true);
    expect(key('End')).toBe(true);
    expect(key('7')).toBe(true);
    expect(key('k')).toBe(false);
    expect(key(' ')).toBe(false);
    ab.isInside.mockReturnValue(false);
    ab.seekLocked.mockReturnValue(true);
    expect(key('ArrowLeft')).toBe(true);
  });

  it('never blocks without a spot', async () => {
    await boot();
    expect(key('ArrowRight')).toBe(false);
  });
});

describe('spent and locked spots on seek', () => {
  it('a seek into a spent spot jumps out of it, using where the playhead came from', async () => {
    const { player, ab } = await withSpot(BRAND);
    player.tick(8);
    ab.skipTargetFor.mockImplementation((at) => (at >= 10 && at < 25 ? 25 : null));
    player.s.currentTime = 12;
    player.trigger('seeking');
    expect(ab.skipTargetFor).toHaveBeenLastCalledWith(12, 8);
    expect(player.currentTime).toHaveBeenLastCalledWith(25);
    // lastSeen is now the target.
    player.s.currentTime = 26;
    player.trigger('seeked');
    expect(ab.skipTargetFor).toHaveBeenLastCalledWith(26, 25);
  });

  it('the lock refuses a seek past an unwatched spot, but not normal playback into it', async () => {
    const { player, ab } = await withSpot(BRAND);
    ab.lockedSeekTarget.mockReturnValue(10);
    player.s.currentTime = 9.9;
    player.trigger('timeupdate');
    expect(player.currentTime).not.toHaveBeenCalledWith(10);
    player.s.currentTime = 50;
    player.trigger('seeking');
    expect(ab.lockedSeekTarget).toHaveBeenCalledWith(50, 9.9);
    expect(player.currentTime).toHaveBeenLastCalledWith(10);
  });

  it('a non-finite clock is ignored and a throwing seek plays through', async () => {
    const { player, ab } = await withSpot(BRAND);
    player.s.currentTime = NaN;
    player.trigger('seeking');
    expect(ab.skipTargetFor).not.toHaveBeenCalled();
    ab.skipTargetFor.mockReturnValue(25);
    player.currentTime.mockImplementation((v) => { if (v !== undefined) throw new Error('x'); return 12; });
    expect(() => player.trigger('seeking')).not.toThrow();
  });
});

describe('frame-accurate jump out of a spent spot', () => {
  function frames() {
    const list = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => { list.push(cb); return list.length; });
    return { run: () => { const cb = list.shift(); if (cb) cb(); }, get size() { return list.length; } };
  }

  it('watches by frame near the cut and leaves just before it', async () => {
    const raf = frames();
    const { player, ab } = await withSpot(BRAND, { spotConsumed: true });
    ab.spotStart.mockReturnValue(10);
    ab.endOfBreak.mockReturnValue(25);
    player.tick(9);
    expect(raf.size).toBe(1);
    // Not armed twice.
    player.tick(9.05);
    expect(raf.size).toBe(1);
    raf.run();
    expect(raf.size).toBe(1); // still 1s away, keeps watching
    player.s.currentTime = 9.9;
    raf.run();
    expect(player.currentTime).toHaveBeenLastCalledWith(25);
    expect(raf.size).toBe(0);
  });

  it('stops watching when paused, too far, or the end is unknown', async () => {
    const raf = frames();
    const { player, ab } = await withSpot(BRAND, { spotConsumed: true });
    ab.spotStart.mockReturnValue(10);
    player.tick(5);
    expect(raf.size).toBe(0);
    player.tick(9);
    expect(raf.size).toBe(1);
    player.s.currentTime = 7;
    raf.run(); // more than 1.5s away again
    expect(raf.size).toBe(0);
    player.tick(9);
    player.s.paused = true;
    raf.run();
    expect(raf.size).toBe(0);
    player.s.paused = false;
    player.tick(9.95);
    ab.endOfBreak.mockReturnValue(NaN);
    player.currentTime.mockClear();
    raf.run();
    expect(player.currentTime).not.toHaveBeenCalledWith(expect.anything());
  });

  it('a throwing seek at the boundary plays through', async () => {
    const raf = frames();
    const { player, ab } = await withSpot(BRAND, { spotConsumed: true });
    ab.spotStart.mockReturnValue(10);
    ab.endOfBreak.mockReturnValue(25);
    player.tick(9.5);
    player.s.currentTime = 9.95;
    player.currentTime.mockImplementation(function (v) { if (v !== undefined) throw new Error('x'); return this.s.currentTime; });
    expect(() => raf.run()).not.toThrow();
  });

  it('is never armed for a spot that has not run, or past it', async () => {
    const raf = frames();
    const { player, ab } = await withSpot(BRAND);
    ab.spotStart.mockReturnValue(10);
    player.tick(9);
    expect(raf.size).toBe(0);
    ab.spotConsumed = true;
    player.tick(12);
    expect(raf.size).toBe(0);
  });
});

describe('ticker', () => {
  const TICKER = {
    adKey: 'tk-1', durationSeconds: 10, label: 'Sponsored', clickUrl: 'https://checker.3speak.tv/t/tk-1',
    productName: 'Badadib Beans', account: 'badadib', message: '<b>Buy</b> beans',
  };

  async function withTicker(info = TICKER, opts) {
    const ctx = await boot(opts);
    ctx.ab.tickerInfo = info;
    ctx.ab.isTickerVisible.mockReturnValue(true);
    ctx.player.s.duration = 120;
    return ctx;
  }

  it('builds the crawl with the advertiser details as text', async () => {
    const { player, ab } = await withTicker();
    player.tick(20);
    expect(ab.isTickerVisible).toHaveBeenCalledWith(20, 120);
    const el = q(player, '.vjs-ticker');
    expect(el.style.getPropertyValue('--ticker-duration')).toBe('10s');
    expect(el.querySelector('.vjs-ticker-label').textContent).toBe('Sponsored');
    const win = el.querySelector('a.vjs-ticker-window');
    expect(win.getAttribute('href')).toBe('https://checker.3speak.tv/t/tk-1');
    expect(win.rel).toBe('noopener noreferrer sponsored');
    expect(win.getAttribute('aria-label')).toBe('Open Badadib Beans in a new tab');
    expect(el.querySelector('.vjs-ticker-avatar').getAttribute('src')).toBe('https://images.hive.blog/u/badadib/avatar/small');
    expect(el.querySelector('.vjs-ticker-account').textContent).toBe('@badadib');
    expect(el.querySelector('.vjs-ticker-product').textContent).toBe('Badadib Beans');
    const msg = el.querySelector('.vjs-ticker-message');
    expect(msg.textContent).toBe('<b>Buy</b> beans');
    expect(msg.querySelector('b')).toBeNull();
    // Paused player: frozen.
    expect(el.classList.contains('is-paused')).toBe(true);
    const surface = vi.fn();
    player.el().addEventListener('pointerdown', surface);
    win.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(surface).not.toHaveBeenCalled();
  });

  it('minimal info: default label and duration, a span and no account', async () => {
    const { player } = await withTicker({ adKey: 'k', message: 'hi' });
    player.tick(1);
    const el = q(player, '.vjs-ticker');
    expect(el.style.getPropertyValue('--ticker-duration')).toBe('15s');
    expect(el.querySelector('.vjs-ticker-label').textContent).toBe('Ad');
    expect(el.querySelector('span.vjs-ticker-window')).not.toBeNull();
    expect(el.querySelector('.vjs-ticker-account')).toBeNull();
    expect(el.querySelector('.vjs-ticker-product')).toBeNull();
  });

  it('play and pause freeze and resume it', async () => {
    const { player } = await withTicker();
    player.tick(1);
    const el = q(player, '.vjs-ticker');
    player.trigger('play');
    expect(el.classList.contains('is-paused')).toBe(false);
    player.trigger('pause');
    expect(el.classList.contains('is-paused')).toBe(true);
  });

  it('counts as seen only after the whole crossing was watched', async () => {
    const { player, ab } = await withTicker();
    player.s.paused = false;
    for (let t = 20; t <= 29; t += 1) player.tick(t);
    expect(ab.tickerWatched).not.toHaveBeenCalled();
    player.tick(29.5);
    expect(ab.tickerWatched).toHaveBeenCalledTimes(1);
    player.tick(30);
    expect(ab.tickerWatched).toHaveBeenCalledTimes(1);
  });

  it('jumps, a hidden tab and paused time are not watched time', async () => {
    const { player, ab } = await withTicker();
    player.s.paused = false;
    player.tick(20);
    player.tick(25); // a jump
    player.tick(26);
    stubProp(document, 'visibilityState', 'hidden');
    player.tick(27);
    player.tick(28);
    stubProp(document, 'visibilityState', 'visible');
    player.s.paused = true;
    player.tick(29);
    player.s.paused = false;
    player.tick(30);
    player.tick(31);
    expect(ab.tickerWatched).not.toHaveBeenCalled();
  });

  it('a report that throws is not a crash', async () => {
    const { player, ab } = await withTicker({ ...TICKER, durationSeconds: 1 });
    ab.tickerWatched.mockImplementation(() => { throw new Error('x'); });
    player.s.paused = false;
    player.tick(1);
    expect(() => player.tick(2)).not.toThrow();
    expect(ab.tickerWatched).toHaveBeenCalledTimes(1);
  });

  it('leaving the window removes it and forgets a partial run', async () => {
    const { player, ab } = await withTicker();
    player.s.paused = false;
    player.tick(20);
    player.tick(25);
    player.tick(26);
    ab.isTickerVisible.mockReturnValue(false);
    player.tick(60);
    expect(q(player, '.vjs-ticker')).toBeNull();
    ab.isTickerVisible.mockReturnValue(true);
    for (let t = 20; t <= 29; t += 1) player.tick(t);
    expect(ab.tickerWatched).not.toHaveBeenCalled();
  });

  it('a spot cutting in pauses it and keeps the watched seconds', async () => {
    const { player, ab } = await withTicker();
    player.s.paused = false;
    for (let t = 20; t <= 25; t += 1) player.tick(t);
    const el = q(player, '.vjs-ticker');
    ab.isTickerVisible.mockReturnValue(false);
    ab.isInside.mockReturnValue(true);
    player.tick(26);
    expect(el.style.display).toBe('none');
    expect(el.classList.contains('is-paused')).toBe(true);
    ab.isInside.mockReturnValue(false);
    ab.isTickerVisible.mockReturnValue(true);
    player.tick(40);
    expect(q(player, '.vjs-ticker')).toBe(el);
    expect(el.style.display).toBe('');
    expect(el.classList.contains('is-paused')).toBe(false);
    for (let t = 41; t <= 45; t += 1) player.tick(t);
    expect(ab.tickerWatched).toHaveBeenCalledTimes(1);
  });

  it('a new ad key rebuilds the strip', async () => {
    const { player, ab } = await withTicker();
    player.tick(1);
    const first = q(player, '.vjs-ticker');
    ab.tickerInfo = { ...TICKER, adKey: 'tk-2' };
    player.tick(2);
    expect(first.isConnected).toBe(false);
    expect(player.el().querySelectorAll('.vjs-ticker')).toHaveLength(1);
  });

  it('the hold style centres a short line and pans a long one', async () => {
    let roCb;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor(cb) { roCb = cb; } observe() {} disconnect() { disconnect(); } });
    const { player, ab } = await withTicker({ ...TICKER, style: 'hold' });
    stubProp(HTMLElement.prototype, 'clientWidth', 400);
    stubProp(HTMLElement.prototype, 'scrollWidth', 200);
    player.tick(1);
    const el = q(player, '.vjs-ticker');
    expect(el.classList.contains('is-hold')).toBe(true);
    expect(el.style.getPropertyValue('--ticker-from')).toBe('400px');
    expect(el.style.getPropertyValue('--ticker-start')).toBe('100px');
    expect(el.style.getPropertyValue('--ticker-end')).toBe('100px');
    expect(el.style.getPropertyValue('--ticker-to')).toBe('-200px');
    expect(el.style.getPropertyValue('--ticker-in-ease')).toBe('cubic-bezier(0.2, 0.9, 0.65, 1.000)');

    stubProp(HTMLElement.prototype, 'scrollWidth', 600);
    roCb();
    expect(el.style.getPropertyValue('--ticker-start')).toBe('12px');
    expect(el.style.getPropertyValue('--ticker-end')).toBe('-212px');

    // Once it is gone the observer lets go.
    ab.isTickerVisible.mockReturnValue(false);
    player.tick(90);
    roCb();
    expect(disconnect).toHaveBeenCalled();
  });

  it('an unmeasurable hold strip is left as a crawl', async () => {
    const { player } = await withTicker({ ...TICKER, style: 'hold' });
    player.tick(1);
    expect(q(player, '.vjs-ticker').classList.contains('is-hold')).toBe(false);
  });
});
