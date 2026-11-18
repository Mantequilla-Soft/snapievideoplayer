import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakePlayer } from './_helpers/fakePlayer.js';

let loadPlaylist;
let mountPlaylist;
let player;
let wrapper;

const LIST = {
  id: 'pl1', owner: 'badadib', name: 'My videos', index: 0,
  items: [
    { v: 'badadib/one', title: 'One', thumbnail: 'https://img.test/1.jpg', duration: 65 },
    { v: 'badadib/two', title: 'Two <b>', thumbnail: null, duration: 3725 },
    { v: 'badadib/three', title: 'Three', thumbnail: null, duration: 0 },
  ],
};
const list = () => ({ ...LIST, items: LIST.items.map((i) => ({ ...i })) });
const bar = () => player.controlBar.el();
const $ = (sel) => document.querySelector(sel);
const dock = () => $('.vjs-playlist-dock');
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** The player in a .player-wrapper of this width (jsdom lays nothing out). */
function setup({ width = 800, fluid = true } = {}) {
  player = createFakePlayer({ withFullscreenButton: true });
  const play = document.createElement('button');
  play.className = 'vjs-play-control';
  bar().prepend(play);
  wrapper = document.createElement('div');
  wrapper.className = 'player-wrapper';
  Object.defineProperty(wrapper, 'clientWidth', { configurable: true, get: () => width });
  document.body.appendChild(wrapper);
  wrapper.appendChild(player.el());
  let isFluid = fluid;
  player.fluid = vi.fn((v) => { if (v === undefined) return isFluid; isFluid = v; return undefined; });
  player.fill = vi.fn();
}

beforeEach(async () => {
  document.body.innerHTML = '';
  document.body.className = '';
  // jsdom has no scrollIntoView; the list scrolls the current video into view.
  Element.prototype.scrollIntoView = vi.fn();
  vi.resetModules();
  ({ loadPlaylist, mountPlaylist } = await import('../../../src/playlist.js'));
  setup();
});
afterEach(() => { player.state.fullscreen = false; });

describe('loadPlaylist', () => {
  it('asks /api/playlist and starts at the first video', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => LIST }));
    vi.stubGlobal('fetch', fetchMock);
    const pl = await loadPlaylist('badadib/pl1');
    expect(fetchMock).toHaveBeenCalledWith('/api/playlist?v=badadib/pl1');
    expect(pl.index).toBe(0);
    expect(pl.items).toHaveLength(3);
  });

  it('null on a 404, an empty list or a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await loadPlaylist('badadib/pl1')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })));
    expect(await loadPlaylist('badadib/pl1')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await loadPlaylist('badadib/pl1')).toBeNull();
  });
});

describe('controls', () => {
  it('puts previous/next after play and the list button before fullscreen', () => {
    mountPlaylist(player, list(), vi.fn());
    const kids = [...bar().children].map((e) => e.className.split(' ').pop());
    expect(kids.indexOf('vjs-playlist-prev')).toBe(kids.indexOf('vjs-play-control') + 1);
    expect(kids.indexOf('vjs-playlist-next')).toBe(kids.indexOf('vjs-playlist-prev') + 1);
    expect($('.vjs-playlist-toggle').nextElementSibling).toBe(player.fsButton);
    expect($('.vjs-playlist-prev').disabled).toBe(true);
    expect($('.vjs-playlist-next').disabled).toBe(false);
  });

  it('one card per video: title as text, duration on the thumbnail, current marked', () => {
    mountPlaylist(player, list(), vi.fn());
    expect($('.vjs-playlist-name').textContent).toBe('My videos');
    expect($('.vjs-playlist-pos').textContent).toBe('1 / 3');
    const cards = [...document.querySelectorAll('.vjs-playlist-card')];
    expect(cards.map((c) => c.querySelector('.vjs-playlist-title').textContent)).toEqual(['One', 'Two <b>', 'Three']);
    expect(cards[1].querySelector('b')).toBeNull();
    expect(cards.map((c) => c.querySelector('.vjs-playlist-dur')?.textContent ?? '')).toEqual(['1:05', '1:02:05', '']);
    expect(cards[0].querySelector('.vjs-playlist-thumb').style.backgroundImage).toContain('https://img.test/1.jpg');
    expect(cards[0].getAttribute('aria-current')).toBe('true');
  });
  it('an audio card carries a headphones mark', () => {
    const pl = list();
    pl.items[2] = { ...pl.items[2], kind: 'audio', audio: 'aud1' };
    mountPlaylist(player, pl, vi.fn());
    const cards = [...document.querySelectorAll('.vjs-playlist-card')];
    expect(cards.map((c) => c.classList.contains('is-audio'))).toEqual([false, false, true]);
    expect(cards[2].querySelector('.vjs-playlist-kind svg')).not.toBeNull();
    expect(cards[0].querySelector('.vjs-playlist-kind')).toBeNull();
  });
});

describe('the docked list', () => {
  it('opens docked beside the player, as a sibling in the wrapper', () => {
    mountPlaylist(player, list(), vi.fn());
    expect(dock().parentElement).toBe(wrapper);
    expect(dock().previousElementSibling).toBe(player.el());
    expect(dock().hidden).toBe(false);
    expect(dock().classList.contains('is-overlay')).toBe(false);
    expect(wrapper.classList.contains('has-playlist-dock')).toBe(true);
    expect($('.vjs-playlist-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('x closes it and gives the player its width back; the list button opens it again', () => {
    mountPlaylist(player, list(), vi.fn());
    $('.vjs-playlist-close').click();
    expect(dock().hidden).toBe(true);
    expect(wrapper.classList.contains('has-playlist-dock')).toBe(false);
    expect($('.vjs-playlist-toggle').getAttribute('aria-expanded')).toBe('false');
    $('.vjs-playlist-toggle').click();
    expect(dock().hidden).toBe(false);
    expect(wrapper.classList.contains('has-playlist-dock')).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('in an embed the player fills the height beside it, and is fluid again once closed', () => {
    document.body.classList.add('iframe-mode');
    mountPlaylist(player, list(), vi.fn());
    expect(player.fluid).toHaveBeenLastCalledWith(false);
    expect(player.fill).toHaveBeenLastCalledWith(true);
    $('.vjs-playlist-close').click();
    expect(player.fill).toHaveBeenLastCalledWith(false);
    expect(player.fluid).toHaveBeenLastCalledWith(true);
  });

  it('docks in a narrow embed too (Ecency, Waves), open from the start', () => {
    document.body.innerHTML = '';
    setup({ width: 320 });
    document.body.classList.add('iframe-mode', 'layout-fill');
    mountPlaylist(player, list(), vi.fn());
    expect(dock().hidden).toBe(false);
    expect(dock().parentElement).toBe(wrapper);
    expect(wrapper.classList.contains('has-playlist-dock')).toBe(true);
  });

  it('on the plain page the player stays fluid', () => {
    mountPlaylist(player, list(), vi.fn());
    expect(player.fill).not.toHaveBeenCalled();
  });

  it('a pick in the docked list plays it and leaves the list open', async () => {
    const playItem = vi.fn(async () => {});
    const pl = list();
    mountPlaylist(player, pl, playItem);
    document.querySelectorAll('.vjs-playlist-card')[2].click();
    await flush();
    expect(playItem).toHaveBeenLastCalledWith(pl.items[2]);
    expect(dock().hidden).toBe(false);
    expect($('.vjs-playlist-pos').textContent).toBe('3 / 3');
  });
});

describe('the list over the video', () => {
  it('a narrow frame starts with it closed; opened, it lies over the video', () => {
    document.body.innerHTML = '';
    setup({ width: 300 });
    mountPlaylist(player, list(), vi.fn());
    expect(dock().hidden).toBe(true);
    $('.vjs-playlist-toggle').click();
    expect(dock().parentElement).toBe(player.el());
    expect(dock().classList.contains('is-overlay')).toBe(true);
    expect(wrapper.classList.contains('has-playlist-dock')).toBe(false);
  });

  it('an embed in layout-fill (its default) docks', () => {
    document.body.classList.add('iframe-mode', 'layout-fill');
    mountPlaylist(player, list(), vi.fn());
    expect(dock().hidden).toBe(false);
    expect(dock().parentElement).toBe(wrapper);
  });

  it('a fixed app layout does not dock either', () => {
    document.body.classList.add('layout-mobile');
    mountPlaylist(player, list(), vi.fn());
    expect(dock().hidden).toBe(true);
  });

  it('moves over the video in fullscreen and back beside it after', () => {
    mountPlaylist(player, list(), vi.fn());
    player.state.fullscreen = true;
    player.trigger('fullscreenchange');
    expect(dock().parentElement).toBe(player.el());
    expect(dock().classList.contains('is-overlay')).toBe(true);
    expect(dock().hidden).toBe(false);
    player.state.fullscreen = false;
    player.trigger('fullscreenchange');
    expect(dock().parentElement).toBe(wrapper);
    expect(dock().classList.contains('is-overlay')).toBe(false);
  });

  it('a pick over the video closes the list so the video shows', async () => {
    document.body.innerHTML = '';
    setup({ width: 300 });
    mountPlaylist(player, list(), vi.fn(async () => {}));
    $('.vjs-playlist-toggle').click();
    document.querySelectorAll('.vjs-playlist-card')[1].click();
    await flush();
    expect(dock().hidden).toBe(true);
  });
});

describe('playing through', () => {
  it('plays the next video when one ends, and stops after the last', async () => {
    const playItem = vi.fn(async () => {});
    const pl = list();
    mountPlaylist(player, pl, playItem);
    player.trigger('ended');
    await flush();
    expect(playItem).toHaveBeenLastCalledWith(pl.items[1]);
    expect($('.vjs-playlist-pos').textContent).toBe('2 / 3');
    player.trigger('ended');
    await flush();
    player.trigger('ended');
    await flush();
    expect(playItem).toHaveBeenCalledTimes(2);
    expect($('.vjs-playlist-next').disabled).toBe(true);
  });

  it('previous and next pick the neighbours', async () => {
    const playItem = vi.fn(async () => {});
    const pl = list();
    mountPlaylist(player, pl, playItem);
    $('.vjs-playlist-next').click();
    await flush();
    $('.vjs-playlist-prev').click();
    await flush();
    expect(playItem.mock.calls.map(([i]) => i.v)).toEqual(['badadib/two', 'badadib/one']);
  });

  it('skips a video that no longer loads', async () => {
    const pl = list();
    const playItem = vi.fn(async (item) => { if (item.v === 'badadib/two') throw new Error('gone'); });
    mountPlaylist(player, pl, playItem);
    $('.vjs-playlist-next').click();
    await flush();
    expect(playItem.mock.calls.map(([i]) => i.v)).toEqual(['badadib/two', 'badadib/three']);
    expect(pl.index).toBe(2);
  });

  it('clicks on its controls do not reach the player', () => {
    mountPlaylist(player, list(), vi.fn());
    const seen = vi.fn();
    wrapper.addEventListener('click', seen);
    $('.vjs-playlist-toggle').click();
    $('.vjs-playlist-close').click();
    dock().click();
    expect(seen).not.toHaveBeenCalled();
  });
});
