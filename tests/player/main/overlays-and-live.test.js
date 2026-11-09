import './_helpers/mocks.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boot, cleanup, calls, hub } from './_helpers/boot.js';

afterEach(() => cleanup());

const card = () => document.querySelector('.player-message');
const state = () => document.getElementById('player-state').textContent;
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('error card', () => {
  it('no ?v= shows the usage hint and never builds a player', async () => {
    const { fetch } = await boot({ url: '/embed?mode=iframe' });
    expect(hub.videojsCalls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    const box = card();
    expect(box.textContent).toContain('No video specified');
    expect(box.style.position).toBe('fixed');
    expect(box.querySelector('img').getAttribute('src')).toBe('/assets/legacyLogo3Speaksmall.png');
    // Only the message line, no debug sub-line.
    expect(box.querySelectorAll('span')).toHaveLength(1);
    const video = document.getElementById('snapie-player');
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.classList.contains('video-js')).toBe(false);
    expect(video.style.display).toBe('none');
    expect(document.querySelectorAll('.player-wrapper .player-logo')).toHaveLength(0);
    expect(document.querySelector('.player-wrapper').style.background).toBe('rgb(0, 0, 0)');
    expect(state()).toBe('Error');
  });

  it('a missing video that is no stream says so and shows the id', async () => {
    quiet();
    const { fetch } = await boot({ routes: { '/api/embed': { status: 404, body: { error: 'Video not found' } } } });
    expect(calls(fetch, '/api/stream')[0][0]).toBe('/api/stream?v=badadib%2Fxyz');
    const spans = card().querySelectorAll('span');
    expect(spans[0].textContent).toBe('Video not found');
    expect(spans[1].textContent).toBe('badadib/xyz');
    expect(hub.videojsCalls).toHaveLength(0);
  });

  it('the server error text is shown when there is one', async () => {
    quiet();
    await boot({ routes: { '/api/embed': { status: 404, body: { error: 'Video is still processing', status: 'encoding' } } } });
    expect(card().querySelector('span').textContent).toBe('Video is still processing');
  });

  it('an error body without a message falls back to a generic one', async () => {
    quiet();
    await boot({ routes: { '/api/embed': { status: 500, body: {} } } });
    expect(card().querySelector('span').textContent).toBe('Failed to fetch video');
  });

  it('a network failure, a broken stream probe and an unreadable probe body all end on the card', async () => {
    quiet();
    await boot({ routes: { '/api/embed': new Error('Failed to fetch'), '/api/stream': new Error('offline') } });
    expect(card().querySelector('span').textContent).toBe('Failed to fetch');
    await boot({ routes: { '/api/embed': { status: 404, body: { error: 'Video not found' } }, '/api/stream': { status: 502, body: '<html>' } } });
    expect(card().querySelector('span').textContent).toBe('Video not found');
  });

  it('a second card replaces the first', async () => {
    quiet();
    await boot({ url: '/embed' });
    expect(document.querySelectorAll('.player-message')).toHaveLength(1);
  });

  it('a non-JSON error response (e.g. an nginx 502 page) shows "Failed to fetch video", not a JSON parse error', async () => {
    quiet();
    await boot({ routes: { '/api/embed': { status: 502, body: '<html>Bad gateway</html>' } } });
    expect(card().querySelector('span').textContent).toBe('Failed to fetch video');
  });
});

describe('ended or live streams behind a video id', () => {
  it('an ended stream post says the stream has ended', async () => {
    quiet();
    await boot({ routes: {
      '/api/embed': { status: 404, body: { error: 'Video not found' } },
      '/api/stream': { status: 404, body: { found: false, endedStream: true } },
    } });
    const spans = card().querySelectorAll('span');
    expect(spans[0].textContent).toBe('This stream has already ended');
    expect(spans[1].textContent).toBe('badadib/xyz');
    expect(state()).toBe('Ended');
  });

  it('an owner/room id that is live opens the live viewer instead of Video.js', async () => {
    quiet();
    await boot({
      url: '/embed?v=badadib/room1&mute=1',
      routes: {
        '/api/embed': { status: 404, body: { error: 'Video not found' } },
        '/api/stream': { body: { found: true, roomName: 'room1', api: 'https://hangout.3speak.tv/api', lk: 'wss://lk', host: 'badadib', watermark: 1 } },
      },
    });
    expect(hub.live).toHaveBeenCalledWith({
      roomName: 'room1', apiBase: 'https://hangout.3speak.tv/api', lkUrl: 'wss://lk',
      host: 'badadib', watermark: true, muted: true,
    });
    expect(hub.videojsCalls).toHaveLength(0);
    expect(card()).toBeNull();
  });

  it('a live viewer that fails to start shows its message', async () => {
    quiet();
    await boot({
      setup: (h) => { h.live = vi.fn(async () => { throw new Error('Room is full'); }); },
      routes: {
        '/api/embed': { status: 404, body: { error: 'Video not found' } },
        '/api/stream': { body: { found: true, roomName: 'r' } },
      },
    });
    expect(card().querySelector('span').textContent).toBe('Room is full');
    expect(state()).toBe('Ended');
  });

  it('a failure without a message gets the default text', async () => {
    quiet();
    await boot({
      setup: (h) => { h.live = vi.fn(async () => { throw new Error(''); }); },
      routes: {
        '/api/embed': { status: 404, body: { error: 'x' } },
        '/api/stream': { body: { found: true, roomName: 'r' } },
      },
    });
    expect(card().querySelector('span').textContent).toBe('Could not start the live session');
  });
});

describe('slash-less ids are streams', () => {
  it('resolves the room and opens the live viewer, skipping the video API', async () => {
    const { fetch } = await boot({
      url: '/embed?v=myroom',
      routes: { '/api/stream': { body: { found: true, roomName: 'myroom', api: 'a', lk: 'l', host: 'badadib' } } },
    });
    expect(calls(fetch, '/api/stream')[0][0]).toBe('/api/stream?v=myroom');
    expect(calls(fetch, '/api/embed')).toHaveLength(0);
    expect(hub.live).toHaveBeenCalledWith({ roomName: 'myroom', apiBase: 'a', lkUrl: 'l', host: 'badadib', watermark: false, muted: false });
    expect(hub.videojsCalls).toHaveLength(0);
  });

  it('an unknown room has ended', async () => {
    await boot({ url: '/embed?v=myroom' });
    const spans = card().querySelectorAll('span');
    expect(spans[0].textContent).toBe('This stream has already ended');
    expect(spans).toHaveLength(1);
  });

  it('a live start failure is shown', async () => {
    await boot({
      url: '/embed?v=myroom',
      setup: (h) => { h.live = vi.fn(async () => { throw new Error('LiveKit down'); }); },
      routes: { '/api/stream': { body: { found: true, roomName: 'myroom' } } },
    });
    expect(card().querySelector('span').textContent).toBe('LiveKit down');
  });

  it('or the default text', async () => {
    await boot({
      url: '/embed?v=myroom',
      setup: (h) => { h.live = vi.fn(async () => { throw new Error(''); }); },
      routes: { '/api/stream': { body: { found: true, roomName: 'myroom' } } },
    });
    expect(card().querySelector('span').textContent).toBe('Could not start the live session');
  });
});

describe('?live= branch', () => {
  it('goes straight to the live viewer with the overrides', async () => {
    const { fetch } = await boot({ url: '/embed?live=room9&api=https://h.example/api&lk=wss://lk.example&mute=yes&mode=iframe&layout=mobile&noscroll=true&debug=1' });
    expect(hub.live).toHaveBeenCalledWith({ roomName: 'room9', apiBase: 'https://h.example/api', lkUrl: 'wss://lk.example', muted: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(hub.videojsCalls).toHaveLength(0);
    expect(document.body.classList.contains('iframe-mode')).toBe(true);
    expect(document.documentElement.classList.contains('iframe-mode')).toBe(true);
    expect(document.body.classList.contains('layout-mobile')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('?room= is an alias and adds no classes by default', async () => {
    await boot({ url: '/embed?room=room9' });
    expect(hub.live).toHaveBeenCalledWith({ roomName: 'room9', apiBase: null, lkUrl: null, muted: false });
    expect(document.body.className).toBe('');
    expect(document.body.style.overflow).toBe('');
  });

  it('a failure shows the error card', async () => {
    await boot({ url: '/embed?live=room9', setup: (h) => { h.live = vi.fn(async () => { throw new Error('No such room'); }); } });
    expect(card().querySelector('span').textContent).toBe('No such room');
    expect(state()).toBe('Error');
    await boot({ url: '/embed?live=room9', setup: (h) => { h.live = vi.fn(async () => { throw null; }); } });
    expect(card().querySelector('span').textContent).toBe('Could not start the live session');
  });
});
