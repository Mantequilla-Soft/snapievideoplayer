import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stubFetch, jsonResponse } from './_helpers/fetchStub.js';
import { setRect } from './_helpers/fakePlayer.js';

const lk = vi.hoisted(() => ({ rooms: [], preroll: null, chat: null }));

vi.mock('livekit-client', async () => {
  const { vi: v } = await import('vitest');
  class Room {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.remoteParticipants = new Map();
      this.canPlaybackAudio = true;
      this.connect = v.fn(async () => {});
      this.startAudio = v.fn(async () => {});
      lk.rooms.push(this);
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    emit(ev, ...args) { (this.handlers[ev] || []).forEach((fn) => fn(...args)); }
  }
  return {
    Room,
    RoomEvent: {
      TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed',
      ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected',
      AudioPlaybackStatusChanged: 'audioPlaybackChanged', Disconnected: 'disconnected',
    },
    Track: { Kind: { Video: 'video', Audio: 'audio' } },
  };
});
vi.mock('../../../src/livePreroll.js', () => ({ playLivePreroll: (...args) => lk.preroll(...args) }));
vi.mock('../../../src/liveChat.js', () => ({ mountLiveChat: (...args) => lk.chat(...args) }));

const { initLiveSession } = await import('../../../src/live.js');

const API = 'https://hangouts.okinoko.io';
let wrapper;
let video;

const q = (sel) => wrapper.querySelector(sel);
const badge = () => q('.live-badge');
const placeholder = () => q('.live-placeholder');
const unmute = () => q('.live-unmute');
const viewers = () => q('.live-viewers').textContent;
const audioSink = () => q('audio');
const room = () => lk.rooms[lk.rooms.length - 1];

function participant(identity, tracks = []) {
  return {
    identity,
    trackPublications: new Map(tracks.map((t, i) => [String(i), { isSubscribed: true, track: t }])),
  };
}
function track(kind) { return { kind, attach: vi.fn(), detach: vi.fn() }; }

/** The hangouts API: room metadata and the guest token. */
function hangouts({ meta = { host: 'badadib' }, token = 'tok-1', listenStatus = 200 } = {}) {
  return stubFetch((url) => {
    if (url.endsWith('/listen')) {
      return listenStatus === 200 ? jsonResponse({ token }) : new Response('', { status: listenStatus });
    }
    if (url.includes('/rooms/')) return meta instanceof Error || meta instanceof Response ? meta : jsonResponse(meta);
    return new Response('', { status: 404 });
  });
}

beforeEach(() => {
  document.body.innerHTML = `
    <img id="logo-top-left">
    <div class="player-wrapper"><video id="snapie-player" class="video-js vjs-default-skin" controls></video></div>`;
  wrapper = document.querySelector('.player-wrapper');
  video = document.getElementById('snapie-player');
  lk.rooms = [];
  lk.preroll = vi.fn(async () => {});
  lk.chat = vi.fn();
});

describe('initLiveSession: setup', () => {
  it('needs a room name and the player container', async () => {
    await expect(initLiveSession()).rejects.toThrow('missing ?live=<room>');
    document.body.innerHTML = '';
    await expect(initLiveSession({ roomName: 'r' })).rejects.toThrow('Player container missing');
  });

  it('turns the Video.js element into a plain muted autoplay surface', async () => {
    hangouts();
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false });
    expect(video.classList.contains('video-js')).toBe(false);
    expect(video.classList.contains('vjs-default-skin')).toBe(false);
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.muted).toBe(true);
    expect(wrapper.style.aspectRatio).toBe('16 / 9');
    expect(audioSink().autoplay).toBe(true);
  });

  it('mints a guest token and connects to LiveKit with it', async () => {
    const net = hangouts();
    const r = await initLiveSession({ roomName: 'badadib room', host: 'badadib', watermark: false });
    expect(net.calls.map((c) => c.url)).toEqual([`${API}/rooms/badadib%20room/listen`]);
    expect(net.calls[0].opts).toMatchObject({ method: 'POST', body: '{}' });
    expect(r).toBe(room());
    expect(r.opts).toEqual({ adaptiveStream: true, dynacast: true });
    expect(r.connect).toHaveBeenCalledWith('wss://livekit.okinoko.io', 'tok-1');
  });

  it('uses the API and LiveKit URLs it is given', async () => {
    const net = hangouts();
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false, apiBase: 'https://api.example/', lkUrl: 'wss://lk.example' });
    expect(net.calls[0].url).toBe('https://api.example/rooms/r/listen');
    expect(room().connect).toHaveBeenCalledWith('wss://lk.example', 'tok-1');
  });

  it('reads the host and watermark from the room when not given', async () => {
    const net = hangouts({ meta: { host: 'badadib', headless: true, watermark: true } });
    await initLiveSession({ roomName: 'r' });
    expect(net.calls[0].url).toBe(`${API}/rooms/r`);
    expect(q('.live-watermark')).not.toBeNull();
    expect(document.getElementById('logo-top-left').style.display).toBe('none');
    expect(lk.preroll).toHaveBeenCalledWith({ wrapper, video, host: 'badadib', room: 'r' });
  });

  it('draws no watermark unless the room is both headless and marked', async () => {
    hangouts({ meta: { host: 'badadib', headless: true, watermark: false } });
    await initLiveSession({ roomName: 'r' });
    expect(q('.live-watermark')).toBeNull();
  });

  it('keeps going when the room metadata cannot be read', async () => {
    hangouts({ meta: new Error('offline') });
    await initLiveSession({ roomName: 'r' });
    hangouts({ meta: new Response('', { status: 500 }) });
    await expect(initLiveSession({ roomName: 'r' })).resolves.toBeDefined();
    expect(lk.preroll).not.toHaveBeenCalled();
  });

  it('only asks the room for the watermark when the host is already known', async () => {
    const net = hangouts({ meta: { host: 'someone-else', headless: true, watermark: true } });
    await initLiveSession({ roomName: 'r', host: 'badadib' });
    expect(net.calls[0].url).toBe(`${API}/rooms/r`);
    expect(lk.preroll).toHaveBeenCalledWith(expect.objectContaining({ host: 'badadib' }));
  });

  it.each([
    [404, 'This stream has already ended'],
    [500, 'Could not join the live session'],
  ])('a %s from the token endpoint is reported', async (status, message) => {
    hangouts({ listenStatus: status });
    await expect(initLiveSession({ roomName: 'r', host: 'badadib', watermark: false })).rejects.toThrow(message);
  });

  it('refuses an answer without a token', async () => {
    hangouts({ token: '' });
    await expect(initLiveSession({ roomName: 'r', host: 'badadib', watermark: false }))
      .rejects.toThrow('did not return a viewer token');
  });

  it('mounts the chat on the room before connecting', async () => {
    hangouts();
    lk.chat.mockImplementation(({ room: r }) => { expect(r.connect).not.toHaveBeenCalled(); });
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false });
    expect(lk.chat).toHaveBeenCalledWith({ wrapper, room: room() });
  });
});

describe('the pre-roll', () => {
  it('hides the stream chrome while it plays and brings it back after', async () => {
    hangouts();
    let during;
    lk.preroll.mockImplementation(async () => {
      during = [badge(), placeholder(), q('.live-viewers')].map((n) => n.style.display);
    });
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false });
    expect(during).toEqual(['none', 'none', 'none']);
    expect(badge().style.display).toBe('flex');
    expect(lk.preroll.mock.invocationCallOrder[0]).toBeLessThan(room().connect.mock.invocationCallOrder[0]);
  });

  it('restores the chrome even if the pre-roll throws', async () => {
    hangouts();
    lk.preroll.mockRejectedValue(new Error('boom'));
    await expect(initLiveSession({ roomName: 'r', host: 'badadib', watermark: false })).rejects.toThrow('boom');
    expect(badge().style.display).toBe('flex');
  });

  it('is skipped when the host is unknown', async () => {
    hangouts({ meta: {} });
    await initLiveSession({ roomName: 'r' });
    expect(lk.preroll).not.toHaveBeenCalled();
  });
});

describe('the stream', () => {
  async function connected(opts = {}) {
    hangouts();
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false, ...opts });
    return room();
  }

  it('attaches the host video and goes LIVE', async () => {
    const r = await connected();
    const v = track('video');
    r.emit('trackSubscribed', v, {}, participant('badadib'));
    expect(v.attach).toHaveBeenCalledWith(video);
    expect(badge().textContent).toBe('LIVE');
    expect(placeholder().style.display).toBe('none');
  });

  it('plays the host audio through its own element', async () => {
    const r = await connected();
    const a = track('audio');
    r.emit('trackSubscribed', a, {}, participant('badadib'));
    expect(a.attach).toHaveBeenCalledWith(audioSink());
    r.emit('trackSubscribed', track('data'), {}, participant('badadib'));
  });

  it('ignores tracks from anyone but the host', async () => {
    const r = await connected();
    const v = track('video');
    r.emit('trackSubscribed', v, {}, participant('guest-1'));
    expect(v.attach).not.toHaveBeenCalled();
    expect(badge().textContent).toBe('OFFLINE');
  });

  it('without a known host, takes the first participant that is not a guest or OBS', async () => {
    hangouts({ meta: {} });
    await initLiveSession({ roomName: 'r' });
    const [g, o, h] = [track('video'), track('video'), track('video')];
    room().emit('trackSubscribed', g, {}, participant('guest-9'));
    room().emit('trackSubscribed', o, {}, participant('obs-ingress'));
    room().emit('trackSubscribed', h, {}, participant('badadib'));
    expect(g.attach).not.toHaveBeenCalled();
    expect(o.attach).not.toHaveBeenCalled();
    expect(h.attach).toHaveBeenCalledWith(video);
  });

  it('detaches an unsubscribed track', async () => {
    const r = await connected();
    const v = track('video');
    r.emit('trackUnsubscribed', v);
    expect(v.detach).toHaveBeenCalled();
  });

  it('counts viewers, leaving out the host and OBS ingress', async () => {
    const r = await connected();
    expect(viewers()).toBe('👁 1');
    for (const id of ['badadib', 'obs-1', 'guest-1', 'guest-2']) r.remoteParticipants.set(id, participant(id));
    r.emit('participantConnected');
    expect(viewers()).toBe('👁 3');
    r.remoteParticipants.delete('guest-2');
    r.emit('participantDisconnected', participant('guest-2'));
    expect(viewers()).toBe('👁 2');
  });

  it('goes offline when the host leaves or the room disconnects', async () => {
    const r = await connected();
    r.emit('trackSubscribed', track('video'), {}, participant('badadib'));
    r.emit('participantDisconnected', participant('badadib'));
    expect(badge().textContent).toBe('OFFLINE');
    expect(placeholder().textContent).toBe('The streamer is offline');
    r.emit('trackSubscribed', track('video'), {}, participant('badadib'));
    r.emit('disconnected');
    expect(badge().textContent).toBe('OFFLINE');
  });

  it('attaches tracks that were already published before it connected', async () => {
    hangouts();
    const v = track('video');
    const unsubscribed = track('audio');
    lk.chat.mockImplementation(({ room: r }) => {
      const p = participant('badadib', [v]);
      p.trackPublications.set('x', { isSubscribed: false, track: unsubscribed });
      r.remoteParticipants.set('badadib', p);
    });
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false });
    expect(v.attach).toHaveBeenCalledWith(video);
    expect(unsubscribed.attach).not.toHaveBeenCalled();
    expect(badge().textContent).toBe('LIVE');
  });

  it('says offline when the host is not in the room', async () => {
    await connected();
    expect(placeholder().textContent).toBe('The streamer is offline');
    expect(placeholder().style.display).toBe('flex');
  });

  it.skip('BUG: says the stream is starting when the host is present but no video landed yet', async () => {
    hangouts();
    lk.chat.mockImplementation(({ room: r }) => { r.remoteParticipants.set('badadib', participant('badadib')); });
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false });
    expect(placeholder().textContent).toBe('Stream is starting…');
  });

  it('offers a tap to enable audio when the browser blocks it', async () => {
    const r = await connected();
    expect(unmute().style.display).toBe('none');
    r.canPlaybackAudio = false;
    r.emit('audioPlaybackChanged');
    expect(unmute().style.display).toBe('block');
    r.startAudio.mockImplementation(async () => { r.canPlaybackAudio = true; });
    unmute().click();
    await vi.waitFor(() => expect(unmute().style.display).toBe('none'));
    expect(r.startAudio).toHaveBeenCalled();
  });

  it('keeps the audio button when starting audio fails', async () => {
    const r = await connected();
    r.canPlaybackAudio = false;
    r.startAudio.mockRejectedValue(new Error('NotAllowedError'));
    unmute().style.display = 'block';
    unmute().click();
    await vi.waitFor(() => expect(r.startAudio).toHaveBeenCalled());
    await Promise.resolve();
    expect(unmute().style.display).toBe('block');
  });

  it('respects ?mute=1 by showing the audio button from the start', async () => {
    await connected({ muted: true });
    expect(unmute().style.display).toBe('block');
  });
});

describe('the fullscreen button', () => {
  function enableBoxFullscreen() {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    let fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsEl });
    wrapper.requestFullscreen = vi.fn(async () => { fsEl = wrapper; });
    document.exitFullscreen = vi.fn(async () => { fsEl = null; });
    return { set: (el) => { fsEl = el; } };
  }

  beforeEach(() => {
    delete document.fullscreenEnabled;
    delete document.fullscreenElement;
  });

  it('is left out where nothing can go fullscreen', async () => {
    hangouts();
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false });
    expect(q('.live-fullscreen')).toBeNull();
  });

  it('takes the whole player box fullscreen and back', async () => {
    const fs = enableBoxFullscreen();
    hangouts();
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false });
    const btn = q('.live-fullscreen');
    expect(btn.title).toBe('Fullscreen');
    btn.click();
    expect(wrapper.requestFullscreen).toHaveBeenCalled();
    await Promise.resolve();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(btn.title).toBe('Exit fullscreen');
    expect(btn.getAttribute('aria-label')).toBe('Exit fullscreen');
    btn.click();
    expect(document.exitFullscreen).toHaveBeenCalled();
    fs.set(null);
  });

  it('swallows a refused fullscreen request', async () => {
    enableBoxFullscreen();
    hangouts();
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false });
    wrapper.requestFullscreen.mockRejectedValue(new Error('not allowed'));
    q('.live-fullscreen').click();
    document.exitFullscreen.mockRejectedValue(new Error('not in fullscreen'));
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => wrapper });
    q('.live-fullscreen').click();
    await Promise.resolve();
    expect(document.exitFullscreen).toHaveBeenCalled();
  });

  it('falls back to the native video fullscreen on iPhone', async () => {
    video.webkitEnterFullscreen = vi.fn();
    hangouts();
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: false });
    q('.live-fullscreen').click();
    expect(video.webkitEnterFullscreen).toHaveBeenCalled();
    video.webkitEnterFullscreen.mockImplementation(() => { throw new Error('nothing playing'); });
    expect(() => q('.live-fullscreen').click()).not.toThrow();
  });
});

describe('the watermark', () => {
  async function withWatermark({ box, frame }) {
    setRect(wrapper, box);
    Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => frame[0] });
    Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => frame[1] });
    hangouts();
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: true });
    return q('.live-watermark');
  }

  it('sits top-left of a 16:9 picture, 6% of its height, and pushes the LIVE badge right', async () => {
    const img = await withWatermark({ box: { width: 1280, height: 720 }, frame: [1920, 1080] });
    expect(img.getAttribute('src')).toBe('/assets/3S_logodark.png');
    expect([img.style.left, img.style.top, img.style.height, img.style.display]).toEqual(['16px', '16px', '43px', 'block']);
    expect(badge().style.left).toBe('198px');
  });

  it('follows the picture inside the letterbox of a 4:3 frame', async () => {
    const img = await withWatermark({ box: { width: 1280, height: 720 }, frame: [1440, 1080] });
    expect([img.style.left, img.style.top]).toEqual(['176px', '16px']);
    expect(badge().style.left).toBe('358px');
  });

  it('assumes the box is the picture before the first frame, and re-measures on metadata', async () => {
    let size = [0, 0];
    setRect(wrapper, { width: 1280, height: 720 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => size[0] });
    Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => size[1] });
    hangouts();
    await initLiveSession({ roomName: 'r', host: 'badadib', watermark: true });
    const img = q('.live-watermark');
    expect(img.style.left).toBe('16px');
    size = [1440, 1080];
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(img.style.left).toBe('176px');
  });

  it('stays hidden while the player has no size', async () => {
    const img = await withWatermark({ box: { width: 0, height: 0 }, frame: [1920, 1080] });
    expect(img.style.display).toBe('none');
  });

  it('works without the corner logo in the page', async () => {
    document.getElementById('logo-top-left').remove();
    const img = await withWatermark({ box: { width: 640, height: 360 }, frame: [1920, 1080] });
    expect(img.style.height).toBe('22px');
  });
});
