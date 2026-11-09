import './_helpers/mocks.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boot, cleanup, flush, videoFixture, posted, FALLBACK_URL } from './_helpers/boot.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const state = () => document.getElementById('player-state').textContent;
const opacity = (id) => document.getElementById(id).style.opacity;

describe('ready', () => {
  it('tunes the VHS buffer for IPFS and reports Ready', async () => {
    const { player } = await boot();
    player.techObj.vhs = { options_: { keep: 1, maxBufferLength: 5 } };
    document.getElementById('player-state').textContent = '';
    player.trigger('ready');
    const vhs = player.techObj.vhs;
    expect(vhs.bandwidth).toBe(2500000);
    expect(vhs.options_).toMatchObject({
      keep: 1, maxBufferLength: 30, maxBufferSize: 100 * 1000 * 1000, maxBufferHole: 1.0,
      enableLowInitialPlaylist: true, maxPlaylistRetries: 5, timeout: 15000,
    });
    expect(state()).toBe('Ready');
  });

  it('a tech that throws only warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { player } = await boot();
    player.tech.mockImplementation(() => { throw new Error('no tech'); });
    player.trigger('ready');
    expect(warn).toHaveBeenCalledWith('Could not apply VHS optimizations:', expect.any(Error));
  });

  it('no VHS (native HLS) leaves things alone', async () => {
    const { player } = await boot();
    player.trigger('ready');
    expect(player.techObj.vhs).toBeUndefined();
    expect(state()).toBe('Ready');
  });
});

describe('loadedmetadata: quality and autoplay', () => {
  it('starts on the middle rendition when there are more than two', async () => {
    const { player } = await boot();
    player.qualityList = [{ enabled: true }, { enabled: true }, { enabled: true }, { enabled: true }];
    player.trigger('loadedmetadata');
    expect(player.qualityList.map((q) => q.enabled)).toEqual([false, false, true, false]);
  });

  it('leaves two renditions alone and survives a throwing qualityLevels()', async () => {
    const { player } = await boot();
    player.qualityList = [{ enabled: true }, { enabled: true }];
    player.trigger('loadedmetadata');
    expect(player.qualityList.map((q) => q.enabled)).toEqual([true, true]);
    player.qualityLevels.mockImplementation(() => { throw new Error('x'); });
    expect(() => player.trigger('loadedmetadata')).not.toThrow();
  });

  it('does not autoplay unless asked', async () => {
    const { player } = await boot();
    player.trigger('loadedmetadata');
    expect(player.play).not.toHaveBeenCalled();
  });

  it('autoplay + mute plays muted straight away', async () => {
    const { player } = await boot({ url: '/embed?v=badadib/xyz&autoplay=1&mute=1' });
    player.playResults.push(new Error('blocked'));
    player.trigger('loadedmetadata');
    await flush();
    expect(player.muted).toHaveBeenCalledWith(true);
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.vjs-muted-autoplay-info')).toBeNull();
  });

  it('autoplay tries with sound first', async () => {
    const { player } = await boot({ url: '/embed?v=badadib/xyz&autoplay=true' });
    player.trigger('loadedmetadata');
    await flush();
    expect(player.muted).toHaveBeenCalledWith(false);
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.vjs-muted-autoplay-info')).toBeNull();
  });

  it('blocked sound falls back to muted and explains why', async () => {
    const { player } = await boot({ url: '/embed?v=badadib/xyz&autoplay=1' });
    player.playResults.push(new Error('NotAllowedError'));
    player.trigger('loadedmetadata');
    await flush();
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(player.muted).toHaveBeenLastCalledWith(true);
    const info = player.el().querySelector('.vjs-muted-autoplay-info');
    expect(info.classList.contains('visible')).toBe(true);

    // The i button toggles the popup; a click anywhere else closes it.
    const popup = info.querySelector('.vjs-muted-autoplay-popup');
    info.querySelector('button').click();
    expect(popup.classList.contains('visible')).toBe(true);
    document.body.click();
    expect(popup.classList.contains('visible')).toBe(false);

    // Unmuting hides the info.
    player.s.muted = false;
    player.trigger('volumechange');
    expect(info.classList.contains('visible')).toBe(false);
  });

  it('nothing is shown when muted autoplay is blocked too', async () => {
    const { player } = await boot({ url: '/embed?v=badadib/xyz&autoplay=1' });
    player.playResults.push(new Error('a'), new Error('b'));
    player.trigger('loadedmetadata');
    await flush();
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.vjs-muted-autoplay-info')).toBeNull();
  });

  it('Chrome skips autoplay entirely', async () => {
    const { player } = await boot({
      url: '/embed?v=badadib/xyz&autoplay=1',
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
    });
    player.trigger('loadedmetadata');
    await flush();
    expect(player.play).not.toHaveBeenCalled();
  });

  it('Edge is not treated as Chrome', async () => {
    const { player } = await boot({
      url: '/embed?v=badadib/xyz&autoplay=1',
      ua: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0',
    });
    player.trigger('loadedmetadata');
    await flush();
    expect(player.play).toHaveBeenCalled();
  });
});

describe('play, pause, ended and the logos', () => {
  it('play reports Playing, hides the replay button and tells the parent', async () => {
    const { player, parent } = await boot();
    player.trigger('ended');
    const replay = player.el().querySelector('.vjs-replay-button');
    expect(replay.style.display).toBe('flex');
    player.trigger('play');
    expect(state()).toBe('Playing');
    expect(replay.style.display).toBe('none');
    expect(posted(parent, '3speak-play')).toHaveLength(1);
  });

  it('pause shows the logos and tells the parent', async () => {
    const { player, parent } = await boot();
    player.s.paused = true;
    player.trigger('pause');
    expect(state()).toBe('Paused');
    expect(opacity('logo-top-left')).toBe('0.85');
    expect(opacity('logo-bottom-right')).toBe('0.85');
    expect(posted(parent, '3speak-pause')).toHaveLength(1);
  });

  it('the logos fade while playing with an idle viewer and come back on activity', async () => {
    const { player } = await boot();
    player.s.paused = false;
    player.s.userActive = false;
    player.trigger('userinactive');
    expect(opacity('logo-top-left')).toBe('0');
    expect(opacity('logo-bottom-right')).toBe('0');
    player.s.userActive = true;
    player.trigger('useractive');
    expect(opacity('logo-top-left')).toBe('0.85');
  });

  it('ended shows one replay button that restarts the video', async () => {
    const { player, parent } = await boot();
    player.s.currentTime = 99;
    player.trigger('ended');
    player.trigger('ended');
    const buttons = player.el().querySelectorAll('.vjs-replay-button');
    expect(buttons).toHaveLength(1);
    expect(state()).toBe('Ended');
    expect(posted(parent, '3speak-ended')).toHaveLength(2);
    buttons[0].click();
    expect(player.currentTime).toHaveBeenCalledWith(0);
    expect(player.play).toHaveBeenCalled();
    expect(buttons[0].style.display).toBe('none');
  });

  it('nothing is posted when the player is not in an iframe', async () => {
    const spy = vi.spyOn(window, 'postMessage');
    const { player } = await boot({ iframe: false });
    player.trigger('play');
    player.trigger('pause');
    player.trigger('ended');
    player.trigger('durationchange');
    player.trigger('volumechange');
    expect(spy).not.toHaveBeenCalled();
  });

  it('durationchange and volumechange are posted to the parent', async () => {
    const { player, parent } = await boot();
    player.s.duration = 321;
    player.trigger('durationchange');
    expect(posted(parent, '3speak-durationchange')).toEqual([{ type: '3speak-durationchange', duration: 321 }]);
    player.s.muted = true;
    player.s.volume = 0.4;
    player.trigger('volumechange');
    expect(posted(parent, '3speak-volumechange')).toEqual([{ type: '3speak-volumechange', muted: true, volume: 0.4 }]);
  });

  it('loadstart and loadeddata only log in debug mode', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { player } = await boot({ url: '/embed?v=badadib/xyz&debug=true' });
    player.s.currentSrc = 'https://x/m.m3u8';
    player.trigger('loadstart');
    player.trigger('loadeddata');
    expect(log).toHaveBeenCalledWith('[3Speak Debug]', 'Loadstart - Current source:', 'https://x/m.m3u8');
    expect(log).toHaveBeenCalledWith('[3Speak Debug]', 'Loaded successfully - Source:', 'https://x/m.m3u8');
  });
});

describe('firstplay: aggressive quality upgrades', () => {
  const levels = [1e6, 3e6, 9e6].map((b) => ({ attributes: { BANDWIDTH: b } }));

  it('picks the best rendition within 1.5x the measured bandwidth', async () => {
    const { player } = await boot();
    const original = { attributes: { BANDWIDTH: 1e6 } };
    player.techObj.vhs = { selectPlaylist: () => original, playlists: { master: { playlists: levels } }, bandwidth: 2e6 };
    player.trigger('firstplay');
    expect(player.techObj.vhs.selectPlaylist()).toBe(levels[1]);
    // One-shot.
    expect(player.listenerCount('firstplay')).toBe(0);
  });

  it('prefers systemBandwidth and keeps the original when nothing fits', async () => {
    const { player } = await boot();
    const original = { attributes: { BANDWIDTH: 1e6 } };
    player.techObj.vhs = { selectPlaylist: () => original, playlists: { master: { playlists: levels } }, systemBandwidth: 1e5 };
    player.trigger('firstplay');
    expect(player.techObj.vhs.selectPlaylist()).toBe(original);
  });

  it('keeps the original without a master playlist', async () => {
    const { player } = await boot();
    const original = { attributes: { BANDWIDTH: 1e6 } };
    player.techObj.vhs = { selectPlaylist: () => original };
    player.trigger('firstplay');
    expect(player.techObj.vhs.selectPlaylist()).toBe(original);
  });

  it('does nothing without VHS and survives a throwing tech', async () => {
    const { player } = await boot();
    player.trigger('firstplay');
    const { player: p2 } = await boot();
    p2.tech.mockImplementation(() => { throw new Error('x'); });
    expect(() => p2.trigger('firstplay')).not.toThrow();
    expect(player.techObj.vhs).toBeUndefined();
  });
});

describe('waiting: stalls', () => {
  it('raises a low bandwidth estimate off a Mac', async () => {
    const { player } = await boot({ platform: 'Linux x86_64', ua: 'Mozilla/5.0 (X11; Linux) Firefox/130' });
    player.techObj.vhs = { bandwidth: 1e6 };
    player.trigger('waiting');
    expect(player.techObj.vhs.bandwidth).toBe(5000000);
    expect(player.stallCount).toBe(1);
  });

  it('counts stalls only when they come within 10 seconds', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { player } = await boot({ platform: 'Linux x86_64', ua: 'X11 Firefox' });
    player.techObj.vhs = { bandwidth: 9e6 };
    player.trigger('waiting');
    vi.advanceTimersByTime(5000);
    player.trigger('waiting');
    expect(player.stallCount).toBe(2);
    expect(player.techObj.vhs.bandwidth).toBe(9e6);
    vi.advanceTimersByTime(11000);
    player.trigger('waiting');
    expect(player.stallCount).toBe(1);
  });

  it('switches to the fallback gateway after three quick stalls and resumes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { player } = await boot({
      platform: 'Linux x86_64', ua: 'X11 Firefox',
      video: videoFixture({ videoUrlFallback: FALLBACK_URL }),
    });
    player.techObj.vhs = { bandwidth: 9e6 };
    player.s.currentTime = 42;
    player.trigger('waiting');
    player.trigger('waiting');
    expect(player.src).toHaveBeenCalledTimes(1);
    player.trigger('waiting');
    expect(warn).toHaveBeenCalled();
    expect(player.src).toHaveBeenLastCalledWith({ src: FALLBACK_URL, type: 'application/x-mpegURL' });
    expect(player.triedFallback).toBe(true);
    expect(player.stallCount).toBe(0);
    expect(state()).toBe('Switched to backup gateway');
    player.trigger('loadedmetadata');
    expect(player.currentTime).toHaveBeenCalledWith(42);
    expect(player.play).toHaveBeenCalled();
    // Only once.
    player.trigger('waiting'); player.trigger('waiting'); player.trigger('waiting');
    expect(player.src).toHaveBeenCalledTimes(2);
  });

  it('cleans the old buffer on a Mac instead of raising the estimate', async () => {
    const { player } = await boot({ platform: 'MacIntel', maxTouchPoints: 0 });
    const remove = vi.fn();
    player.techObj.vhs = { bandwidth: 1e6, playlistController_: { sourceUpdater_: { remove } } };
    player.s.currentTime = 30;
    player.trigger('waiting');
    expect(remove).toHaveBeenCalledWith('video', 0, 20);
    expect(remove).toHaveBeenCalledWith('audio', 0, 20);
    expect(player.techObj.vhs.bandwidth).toBe(1e6);
  });

  it('a Mac early in the video has nothing to clean, and a throwing remove is swallowed', async () => {
    const { player } = await boot({ platform: 'MacIntel', maxTouchPoints: 0 });
    const remove = vi.fn(() => { throw new Error('quota'); });
    player.techObj.vhs = { masterPlaylistController_: { sourceUpdater_: { remove } } };
    player.s.currentTime = 5;
    player.trigger('waiting');
    expect(remove).not.toHaveBeenCalled();
    player.s.currentTime = 50;
    expect(() => player.trigger('waiting')).not.toThrow();
    expect(remove).toHaveBeenCalled();
  });

  it('without VHS a stall only counts', async () => {
    const { player } = await boot();
    player.trigger('waiting');
    expect(player.stallCount).toBe(1);
    player.tech.mockImplementation(() => { throw new Error('x'); });
    expect(() => player.trigger('waiting')).not.toThrow();
  });
});

describe('error', () => {
  const quiet = () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  };

  it('a decode error first retries on the fallback gateway', async () => {
    quiet();
    const { player } = await boot({ video: videoFixture({ videoUrlFallback: FALLBACK_URL }) });
    player.s.error = { code: 3, message: 'decode' };
    player.techObj.vhs = { playlists: { media: () => ({ uri: 'x.m3u8' }) }, bandwidth: 1 };
    player.trigger('error');
    expect(player.src).toHaveBeenLastCalledWith({ src: FALLBACK_URL, type: 'application/x-mpegURL' });
    expect(player.load).toHaveBeenCalledTimes(2);
    expect(state()).toBe('Retrying with different gateway...');
    expect(document.querySelector('.vjs-codec-error-overlay')).toBeNull();

    // The second decode error shows the codec card, once.
    player.trigger('error');
    player.trigger('error');
    const cards = player.el().querySelectorAll('.vjs-codec-error-overlay');
    expect(cards).toHaveLength(1);
    expect(cards[0].style.display).toBe('flex');
    expect(cards[0].querySelector('#error-platform').textContent).not.toBe('');
    expect(state()).toBe('Decode Error - See Console');
  });

  it('a decode error without a fallback goes straight to the codec card', async () => {
    quiet();
    const { player } = await boot({ ua: '', platform: '' });
    player.s.error = { code: 3, message: 'decode' };
    player.trigger('error');
    const card = player.el().querySelector('.vjs-codec-error-overlay');
    expect(card).not.toBeNull();
    expect(card.querySelector('#error-browser').textContent).toBe('Unknown');
    expect(card.querySelector('#error-platform').textContent).toBe('Unknown');
  });

  it('a network error retries the fallback once, then reports Error', async () => {
    quiet();
    const { player } = await boot({ video: videoFixture({ videoUrlFallback: FALLBACK_URL }) });
    player.s.error = { code: 2, message: 'network' };
    player.trigger('error');
    expect(player.src).toHaveBeenLastCalledWith({ src: FALLBACK_URL, type: 'application/x-mpegURL' });
    expect(state()).toBe('Retrying with fallback gateway...');
    player.trigger('error');
    expect(state()).toBe('Error');
    expect(player.src).toHaveBeenCalledTimes(2);
  });

  it('logs the detail of an unknown error code and survives a throwing tech', async () => {
    quiet();
    const { player } = await boot();
    player.s.error = { code: 9, message: '??' };
    player.tech.mockImplementation(() => { throw new Error('gone'); });
    player.trigger('error');
    expect(console.error).toHaveBeenCalledWith('🔴 DETAILED ERROR INFO:', expect.objectContaining({ type: 'UNKNOWN', code: 9 }));
    expect(console.error).toHaveBeenCalledWith('Could not get VHS details:', expect.any(Error));
    expect(state()).toBe('Error');
  });

  it('an error with no MediaError still ends in Error', async () => {
    quiet();
    const { player } = await boot();
    player.trigger('error');
    expect(state()).toBe('Error');
  });
});

describe('timeupdate: periodic buffer cleanup on a Mac', () => {
  it('drops what is more than 10 s behind, at most every 5 s of playback', async () => {
    const { player } = await boot({ platform: 'MacIntel', maxTouchPoints: 0 });
    const remove = vi.fn();
    player.techObj.vhs = { playlistController_: { sourceUpdater_: { remove } } };
    player.tick(10); // too early in the video
    expect(remove).not.toHaveBeenCalled();
    player.tick(14); // within 5 s of the last check
    expect(remove).not.toHaveBeenCalled();
    player.tick(20);
    expect(remove).toHaveBeenCalledWith('video', 0, 10);
    expect(remove).toHaveBeenCalledWith('audio', 0, 10);
    player.tick(22);
    expect(remove).toHaveBeenCalledTimes(2);
    remove.mockImplementation(() => { throw new Error('quota'); });
    expect(() => player.tick(30)).not.toThrow();
  });

  it('never runs off a Mac', async () => {
    const { player } = await boot({ platform: 'Linux x86_64', ua: 'X11 Firefox' });
    const remove = vi.fn();
    player.techObj.vhs = { playlistController_: { sourceUpdater_: { remove } } };
    player.tick(60);
    expect(remove).not.toHaveBeenCalled();
  });
});
