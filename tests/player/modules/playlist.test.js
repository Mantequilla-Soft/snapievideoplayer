import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakePlayer } from './_helpers/fakePlayer.js';

let loadPlaylist;
let mountPlaylist;
let player;

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
const $ = (sel) => player.el().querySelector(sel);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(async () => {
  document.body.innerHTML = '';
  // jsdom has no scrollIntoView; the panel scrolls the current video into view.
  Element.prototype.scrollIntoView = vi.fn();
  vi.resetModules();
  ({ loadPlaylist, mountPlaylist } = await import('../../../src/playlist.js'));
  player = createFakePlayer({ withFullscreenButton: true });
  const play = document.createElement('button');
  play.className = 'vjs-play-control';
  bar().prepend(play);
});

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

describe('mountPlaylist', () => {
  it('puts previous/next after play and the list button before fullscreen', () => {
    mountPlaylist(player, list(), vi.fn());
    const kids = [...bar().children].map((e) => e.className.split(' ').pop());
    expect(kids.indexOf('vjs-playlist-prev')).toBe(kids.indexOf('vjs-play-control') + 1);
    expect(kids.indexOf('vjs-playlist-next')).toBe(kids.indexOf('vjs-playlist-prev') + 1);
    expect($('.vjs-playlist-toggle').nextElementSibling).toBe(player.fsButton);
    expect($('.vjs-playlist-prev').disabled).toBe(true);
    expect($('.vjs-playlist-next').disabled).toBe(false);
  });

  it('lists every video with its title as text, position and durations', () => {
    mountPlaylist(player, list(), vi.fn());
    expect($('.vjs-playlist-name').textContent).toBe('My videos');
    expect($('.vjs-playlist-pos').textContent).toBe('1 / 3');
    const rows = [...player.el().querySelectorAll('.vjs-playlist-item')];
    expect(rows.map((r) => r.querySelector('.vjs-playlist-title').textContent)).toEqual(['One', 'Two <b>', 'Three']);
    expect(rows[1].querySelector('b')).toBeNull();
    expect(rows.map((r) => r.querySelector('.vjs-playlist-dur').textContent)).toEqual(['1:05', '1:02:05', '']);
    expect(rows[0].getAttribute('aria-current')).toBe('true');
  });

  it('the list button opens and closes the panel', () => {
    mountPlaylist(player, list(), vi.fn());
    const toggle = $('.vjs-playlist-toggle');
    expect($('.vjs-playlist-panel').hidden).toBe(true);
    toggle.click();
    expect($('.vjs-playlist-panel').hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    toggle.click();
    expect($('.vjs-playlist-panel').hidden).toBe(true);
  });

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

  it('previous, next and a click in the list pick that video and close the list', async () => {
    const playItem = vi.fn(async () => {});
    const pl = list();
    mountPlaylist(player, pl, playItem);
    $('.vjs-playlist-toggle').click();
    player.el().querySelectorAll('.vjs-playlist-item')[2].click();
    await flush();
    expect(playItem).toHaveBeenLastCalledWith(pl.items[2]);
    expect($('.vjs-playlist-panel').hidden).toBe(true);
    $('.vjs-playlist-prev').click();
    await flush();
    expect(playItem).toHaveBeenLastCalledWith(pl.items[1]);
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
    player.el().addEventListener('click', seen);
    $('.vjs-playlist-toggle').click();
    $('.vjs-playlist-panel').click();
    expect(seen).not.toHaveBeenCalled();
  });
});
