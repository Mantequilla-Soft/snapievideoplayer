import './_helpers/mocks.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boot, cleanup, flush, send, posted, hub, stubProp } from './_helpers/boot.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('postMessage commands from the embedding page', () => {
  it('ignores empty messages and unknown commands', async () => {
    const { player } = await boot();
    send(null);
    send({ type: 'launch-rockets' });
    expect(player.play).not.toHaveBeenCalled();
    expect(player.pause).not.toHaveBeenCalled();
  });

  it('play re-applies the intended mute state, then plays', async () => {
    const { player } = await boot();
    player.s.muted = true; // video.js reset it behind our back
    send({ type: 'play' });
    await flush();
    expect(player.muted).toHaveBeenCalledWith(false);
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('play with sound blocked falls back to muted and shows the info', async () => {
    const { player } = await boot();
    player.playResults.push(new Error('NotAllowedError'));
    send({ action: 'playVideo' });
    await flush();
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(player.muted).toHaveBeenLastCalledWith(true);
    expect(document.querySelector('.vjs-muted-autoplay-info.visible')).not.toBeNull();
  });

  it('play blocked even muted shows nothing', async () => {
    const { player } = await boot();
    player.playResults.push(new Error('a'), new Error('b'));
    send({ type: 'play' });
    await flush();
    expect(document.querySelector('.vjs-muted-autoplay-info')).toBeNull();
  });

  it('play in a muted embed stays muted', async () => {
    const { player } = await boot({ url: '/embed?v=badadib/xyz&mute=1' });
    player.playResults.push(new Error('blocked'));
    send({ command: 'play' });
    await flush();
    expect(player.muted).toHaveBeenLastCalledWith(true);
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('pause, toggle-play', async () => {
    const { player } = await boot();
    send({ type: 'pauseVideo' });
    expect(player.pause).toHaveBeenCalledTimes(1);
    player.s.paused = true;
    send({ type: 'toggle-play' });
    expect(player.play).toHaveBeenCalledTimes(1);
    player.s.paused = false;
    send({ type: 'togglePlay' });
    expect(player.pause).toHaveBeenCalledTimes(2);
  });

  it('mute, unmute and toggleMute track the intended state', async () => {
    const { player, parent } = await boot();
    send({ type: 'mute' });
    expect(player.s.muted).toBe(true);
    send({ type: 'unmute' });
    expect(player.s.muted).toBe(false);
    send({ type: 'toggleMute' });
    expect(player.s.muted).toBe(true);
    send({ type: 'getState' });
    expect(posted(parent, '3speak-state')[0]).toMatchObject({ muted: true, intendedMuted: true });
  });

  it('seek, seekForward and seekBackward', async () => {
    const { player } = await boot();
    send({ type: 'seek', time: 30 });
    expect(player.s.currentTime).toBe(30);
    send({ type: 'seek', time: 'nope' });
    expect(player.s.currentTime).toBe(30);
    send({ type: 'seekForward' });
    expect(player.s.currentTime).toBe(40);
    send({ type: 'seekForward', seconds: 5 });
    expect(player.s.currentTime).toBe(45);
    send({ type: 'seekBackward' });
    expect(player.s.currentTime).toBe(35);
    send({ type: 'seekBackward', seconds: 30 });
    expect(player.s.currentTime).toBe(5);
  });

  it('fullscreen toggles, enters and exits only when needed', async () => {
    const { player } = await boot();
    send({ type: 'toggleFullscreen' });
    expect(player.requestFullscreen).toHaveBeenCalledTimes(1);
    send({ type: 'toggle-fullscreen' });
    expect(player.exitFullscreen).toHaveBeenCalledTimes(1);
    send({ type: 'exitFullscreen' });
    expect(player.exitFullscreen).toHaveBeenCalledTimes(1);
    send({ type: 'enter-fullscreen' });
    send({ type: 'enterFullscreen' });
    expect(player.requestFullscreen).toHaveBeenCalledTimes(2);
    send({ type: 'exit-fullscreen' });
    expect(player.exitFullscreen).toHaveBeenCalledTimes(2);
  });

  it('lock-orientation follows the video shape; unlock releases it', async () => {
    const lock = vi.fn(() => Promise.resolve());
    const unlock = vi.fn();
    const { player } = await boot();
    stubProp(screen, 'orientation', { lock, unlock });
    send({ type: 'lock-orientation' });
    expect(lock).toHaveBeenLastCalledWith('landscape');
    player.s.videoWidth = 720; player.s.videoHeight = 1280;
    player.trigger('loadedmetadata');
    send({ type: 'lock-orientation' });
    expect(lock).toHaveBeenLastCalledWith('portrait');
    lock.mockImplementation(() => Promise.reject(new Error('not allowed')));
    send({ type: 'lock-orientation' });
    await flush();
    send({ type: 'unlock-orientation' });
    expect(unlock).toHaveBeenCalled();
  });

  it('orientation commands are harmless without the API', async () => {
    await boot();
    stubProp(screen, 'orientation', undefined);
    expect(() => { send({ type: 'lock-orientation' }); send({ type: 'unlock-orientation' }); }).not.toThrow();
  });

  it('fullscreen-entered makes the player fill the parent', async () => {
    const { player } = await boot();
    send({ type: 'fullscreen-entered' });
    expect(player.fill).toHaveBeenCalledWith(true);
    expect(player.fluid).toHaveBeenCalledWith(false);
    expect(player.width).toHaveBeenCalledWith('100%');
    expect(player.height).toHaveBeenCalledWith('100%');
    expect(document.body.classList.contains('tv-fullscreen-mode')).toBe(true);
  });

  it('fullscreen-exited clears inline sizes and restores fluid on a fluid page', async () => {
    vi.useFakeTimers();
    const { player } = await boot({ url: '/watch?v=badadib/xyz' });
    const wrapper = document.querySelector('.player-wrapper');
    wrapper.style.width = '50px';
    wrapper.style.paddingBottom = '10px';
    player.el().style.position = 'fixed';
    player.techEl.style.transform = 'scale(2)';
    send({ type: 'fullscreen-entered' });
    send({ type: 'fullscreen-exited' });
    expect(document.body.classList.contains('tv-fullscreen-mode')).toBe(false);
    expect(wrapper.style.width).toBe('');
    expect(wrapper.style.paddingBottom).toBe('');
    expect(player.el().style.position).toBe('');
    expect(player.techEl.style.transform).toBe('');
    expect(player.fill).toHaveBeenLastCalledWith(false);
    expect(player.fluid).toHaveBeenLastCalledWith(true);
    expect(player.width).toHaveBeenLastCalledWith('');
    const resize = vi.fn();
    player.on('playerresize', resize);
    const winResize = vi.fn();
    window.addEventListener('resize', winResize);
    vi.advanceTimersByTime(100);
    expect(resize).toHaveBeenCalled();
    expect(winResize).toHaveBeenCalled();
  });

  it('fullscreen-exited in a fixed layout does not turn fluid back on', async () => {
    const { player } = await boot({ url: '/embed?v=badadib/xyz&layout=square' });
    document.querySelector('.player-wrapper').remove();
    player.techObj = { el: () => null };
    send({ type: 'fullscreen-exited' });
    expect(player.fluid).not.toHaveBeenCalledWith(true);
  });

  it('setVolume clamps and unmutes; volume up and down step', async () => {
    const { player } = await boot();
    player.s.muted = true;
    send({ type: 'setVolume', volume: 3 });
    expect(player.s.volume).toBe(1);
    expect(player.s.muted).toBe(false);
    send({ type: 'set-volume', volume: -1 });
    expect(player.s.volume).toBe(0);
    send({ type: 'set-volume', volume: 'loud' });
    expect(player.s.volume).toBe(0);
    send({ type: 'volumeUp' });
    expect(player.s.volume).toBeCloseTo(0.1);
    player.s.muted = true;
    send({ type: 'volume-up', step: 0.5 });
    expect(player.s.volume).toBeCloseTo(0.6);
    expect(player.s.muted).toBe(false);
    send({ type: 'volumeDown' });
    expect(player.s.volume).toBeCloseTo(0.5);
    send({ type: 'volume-down', step: 2 });
    expect(player.s.volume).toBe(0);
  });

  it('setVolume to 0 keeps a muted player muted', async () => {
    const { player } = await boot();
    player.s.muted = true;
    send({ type: 'setVolume', volume: 0 });
    expect(player.s.muted).toBe(true);
  });

  it('toggle-pip enters picture-in-picture on the inner <video>, and exits it', async () => {
    const { player } = await boot();
    const wrap = document.createElement('div');
    const v = document.createElement('video');
    v.requestPictureInPicture = vi.fn(() => Promise.reject(new Error('denied')));
    wrap.appendChild(v);
    player.techObj = { el: () => wrap };
    send({ type: 'toggle-pip' });
    await flush();
    expect(v.requestPictureInPicture).toHaveBeenCalled();

    stubProp(document, 'pictureInPictureElement', v);
    document.exitPictureInPicture = vi.fn(() => Promise.reject(new Error('x')));
    send({ type: 'togglePip' });
    await flush();
    expect(document.exitPictureInPicture).toHaveBeenCalled();
    delete document.exitPictureInPicture;
  });

  it('toggle-pip without support does nothing', async () => {
    const { player } = await boot();
    player.techObj = { el: () => document.createElement('div') };
    expect(() => send({ type: 'toggle-pip' })).not.toThrow();
  });

  it('getState reports the player', async () => {
    const { player, parent } = await boot();
    Object.assign(player.s, { currentTime: 12, duration: 120, paused: false, volume: 0.7, ended: false });
    send({ type: 'get-state' });
    expect(posted(parent, '3speak-state')).toEqual([{
      type: '3speak-state', currentTime: 12, duration: 120, paused: false, muted: false,
      intendedMuted: false, volume: 0.7, ended: false,
    }]);
  });

  it('getQualityLevels lists the renditions and finds the selected one', async () => {
    const { player, parent } = await boot();
    player.qualityList = [
      { height: 480, width: 854, bitrate: 1e6, enabled: false },
      { height: 720, width: 1280, bitrate: 3e6, enabled: true },
      { enabled: false },
    ];
    send({ type: 'getQualityLevels' });
    const [msg] = posted(parent, '3speak-quality-levels');
    expect(msg.currentIndex).toBe(1);
    expect(msg.levels).toEqual([
      { index: 0, height: 480, width: 854, bitrate: 1e6, label: '480p', enabled: false },
      { index: 1, height: 720, width: 1280, bitrate: 3e6, label: '720p', enabled: true },
      { index: 2, height: 0, width: 0, bitrate: 0, label: 'Level 2', enabled: false },
    ]);
  });

  it('getQualityLevels is auto (-1) when several or none are enabled', async () => {
    const { player, parent } = await boot();
    player.qualityList = [{ height: 480 }, { height: 720 }];
    send({ type: 'get-quality-levels' });
    expect(posted(parent, '3speak-quality-levels')[0].currentIndex).toBe(-1);
    player.qualityList = [];
    send({ type: 'get-quality-levels' });
    expect(posted(parent, '3speak-quality-levels')[1]).toEqual({ type: '3speak-quality-levels', levels: [], currentIndex: -1 });
  });

  it('setQualityLevel picks one rendition, auto enables all, junk is ignored', async () => {
    const { player, parent } = await boot();
    player.qualityList = [{ enabled: true, height: 480 }, { enabled: true }, { enabled: true }];
    send({ type: 'setQualityLevel', level: 1 });
    expect(player.qualityList.map((q) => q.enabled)).toEqual([false, true, false]);
    send({ type: 'set-quality-level', level: 0 });
    expect(player.qualityList.map((q) => q.enabled)).toEqual([true, false, false]);
    send({ type: 'set-quality-level', level: 'auto' });
    expect(player.qualityList.map((q) => q.enabled)).toEqual([true, true, true]);
    send({ type: 'set-quality-level', level: 0 });
    send({ type: 'set-quality-level', level: -1 });
    expect(player.qualityList.map((q) => q.enabled)).toEqual([true, true, true]);
    send({ type: 'set-quality-level', level: 7 });
    expect(player.qualityList.map((q) => q.enabled)).toEqual([true, true, true]);
    expect(posted(parent, '3speak-quality-changed').map((m) => m.level)).toEqual([1, 0, 'auto', 0, -1, 7]);
  });

  it('setQualityLevel with no renditions says nothing', async () => {
    const { parent } = await boot();
    send({ type: 'setQualityLevel', level: 1 });
    expect(posted(parent, '3speak-quality-changed')).toHaveLength(0);
  });

  it('captions: select a language and list them', async () => {
    const { parent } = await boot();
    send({ type: 'setCaptions', lang: 'es' });
    expect(hub.subtitle.selectLanguage).toHaveBeenCalledWith('es');
    send({ type: 'set-captions' });
    expect(hub.subtitle.selectLanguage).toHaveBeenLastCalledWith(null);
    send({ type: 'getCaptionLanguages' });
    expect(posted(parent, '3speak-caption-languages')).toEqual([
      { type: '3speak-caption-languages', languages: ['en', 'es'], selectedLang: 'en' },
    ]);
  });

  it('captions=0 ignores setCaptions', async () => {
    await boot({ url: '/embed?v=badadib/xyz&captions=0' });
    send({ type: 'setCaptions', lang: 'es' });
    expect(hub.subtitle.selectLanguage).not.toHaveBeenCalled();
  });

  it('query commands answer nobody outside an iframe', async () => {
    const spy = vi.spyOn(window, 'postMessage');
    const { player } = await boot({ iframe: false });
    player.qualityList = [{ enabled: true }];
    send({ type: 'getState' });
    send({ type: 'getQualityLevels' });
    send({ type: 'setQualityLevel', level: 0 });
    send({ type: 'getCaptionLanguages' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('timeupdate to the parent', () => {
  it('is throttled to four a second', async () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const { player, parent } = await boot();
    Object.assign(player.s, { duration: 120, paused: false, volume: 0.5 });
    player.tick(1);
    player.tick(1.1);
    expect(posted(parent, '3speak-timeupdate')).toEqual([{
      type: '3speak-timeupdate', currentTime: 1, duration: 120, paused: false, muted: false, volume: 0.5,
    }]);
    vi.advanceTimersByTime(250);
    player.tick(1.3);
    expect(posted(parent, '3speak-timeupdate')).toHaveLength(2);
  });
});
