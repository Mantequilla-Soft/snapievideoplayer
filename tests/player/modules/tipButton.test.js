import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakePlayer } from './_helpers/fakePlayer.js';

let setTipVideo;
let player;
const VIDEO = { owner: 'badadib', permlink: 'badadib-video', type: 'embed' };
const tip = () => player.el().querySelector('.vjs-tip-button');

beforeEach(async () => {
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
  vi.resetModules();
  ({ setTipVideo } = await import('../../../src/tipButton.js'));
  player = createFakePlayer({ withFullscreenButton: true });
});

describe('setTipVideo', () => {
  it('adds a tip link before fullscreen for a finished video', () => {
    setTipVideo(player, VIDEO);
    const a = tip();
    expect(a.nextElementSibling).toBe(player.fsButton);
    expect(a.href).toBe('https://3speak.tv/tip/@badadib/badadib-video?kind=video');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener');
    expect(a.getAttribute('aria-label')).toBe('Tip the creator');
    expect(a.style.display).toBe('');
  });

  it('appends it when the control bar has no fullscreen button', () => {
    player = createFakePlayer();
    setTipVideo(player, VIDEO);
    expect(player.controlBar.el().lastElementChild).toBe(tip());
  });

  it('links a video by its Hive permlink when it differs from the asset', () => {
    setTipVideo(player, { ...VIDEO, type: 'legacy', hivePermlink: 'badadib-post' });
    expect(tip().href).toBe('https://3speak.tv/tip/@badadib/badadib-post?kind=video');
  });

  it('links a short by its asset id', () => {
    setTipVideo(player, { ...VIDEO, short: true, hivePermlink: 'ignored' });
    expect(tip().href).toBe('https://3speak.tv/tip/@badadib/badadib-video?kind=short');
  });

  it('encodes the path parts', () => {
    setTipVideo(player, { ...VIDEO, permlink: 'a b/c' });
    expect(tip().href).toBe('https://3speak.tv/tip/@badadib/a%20b%2Fc?kind=video');
  });

  it('points at preview only for ?tip=preview', () => {
    window.history.replaceState(null, '', '/?tip=preview');
    setTipVideo(player, VIDEO);
    expect(tip().href.startsWith('https://preview.3speak.tv/tip/')).toBe(true);
    window.history.replaceState(null, '', '/?tip=https://evil.example');
    setTipVideo(player, VIDEO);
    expect(tip().href.startsWith('https://3speak.tv/tip/')).toBe(true);
  });

  it('does not create a button for something that cannot be tipped', () => {
    for (const v of [null, { ...VIDEO, owner: '' }, { ...VIDEO, permlink: '' }, { ...VIDEO, isPlaceholder: true }, { ...VIDEO, type: 'live' }]) {
      setTipVideo(player, v);
    }
    expect(tip()).toBeNull();
  });

  it('hides an existing button for the next video if that one cannot be tipped', () => {
    setTipVideo(player, VIDEO);
    setTipVideo(player, { ...VIDEO, type: 'live' });
    expect(tip().style.display).toBe('none');
    setTipVideo(player, VIDEO);
    expect(tip().style.display).toBe('');
    expect(player.el().querySelectorAll('.vjs-tip-button')).toHaveLength(1);
  });
});

describe('clicking the tip button', () => {
  beforeEach(() => {
    vi.stubGlobal('screen', { width: 1440, height: 900 });
    setTipVideo(player, VIDEO);
  });

  it('pauses, leaves fullscreen and opens a centred popup', () => {
    player.state.paused = false;
    player.state.fullscreen = true;
    const open = vi.spyOn(window, 'open').mockReturnValue({});
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    const onPlayer = vi.fn();
    player.el().addEventListener('click', onPlayer);
    tip().dispatchEvent(ev);
    expect(player.pause).toHaveBeenCalled();
    expect(player.exitFullscreen).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      'https://3speak.tv/tip/@badadib/badadib-video?kind=video', '3speak-tip', 'popup,width=440,height=720,left=500,top=90',
    );
    expect(ev.defaultPrevented).toBe(true);
    expect(onPlayer).not.toHaveBeenCalled();
  });

  it('falls back to the plain link when the popup is blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    tip().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.exitFullscreen).not.toHaveBeenCalled();
  });

  it('never places the popup off screen', () => {
    vi.stubGlobal('screen', { width: 300, height: 400 });
    const open = vi.spyOn(window, 'open').mockReturnValue({});
    tip().click();
    expect(open.mock.calls[0][2]).toBe('popup,width=440,height=720,left=0,top=0');
  });
});
