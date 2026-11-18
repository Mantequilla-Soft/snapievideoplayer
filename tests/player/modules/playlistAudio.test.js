import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakePlayer } from './_helpers/fakePlayer.js';

const API = 'https://audio.test';
const CHECKER = 'https://checker.test';
let audioSources;
let loadAudio;
let stopAudio;
let player;
let fetchMock;
let answers;

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const posts = (url) => fetchMock.mock.calls.filter(([u]) => u === url).map(([, init]) => JSON.parse(init.body));

beforeEach(async () => {
  vi.resetModules();
  ({ audioSources, loadAudio, stopAudio } = await import('../../../src/playlistAudio.js'));
  player = createFakePlayer({ duration: 60 });
  Object.assign(player, {
    src: vi.fn(),
    load: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    error: vi.fn(),
    one: vi.fn((ev, fn) => player.on(ev, fn)),
    playbackRate: vi.fn(() => 1),
  });
  answers = {
    [`${API}/api/audio/play-start`]: { sid: 's1', token: 't1', beatSeconds: 3 },
    [`${API}/api/audio/play-beat`]: { ok: true },
    [`${CHECKER}/audio/listen/start`]: { sid: 'l1', token: 'lt1', beatSeconds: 10 },
    [`${CHECKER}/audio/listen/beat`]: { ok: true },
  };
  fetchMock = vi.fn(async (url) => {
    const key = String(url).split('?')[0];
    const body = answers[key];
    return body ? { ok: true, json: async () => body } : { ok: false, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('audioSources', () => {
  it('the MP3 copy first, then the original, each on its gateway and on the b-cdn one', async () => {
    answers[`${API}/api/audio`] = {
      format: 'webm', audio_cid: 'QmA', mp3_cid: 'QmM',
      audioUrl: 'https://gw.test/ipfs/QmA', audioUrlFallback: 'https://ipfs.io/ipfs/QmA', mp3Url: 'https://gw.test/ipfs/QmM',
    };
    expect(await audioSources(API, 'aud1')).toEqual([
      { src: 'https://gw.test/ipfs/QmM', type: 'audio/mpeg' },
      { src: 'https://ipfs-3speak.b-cdn.net/ipfs/QmM', type: 'audio/mpeg' },
      { src: 'https://gw.test/ipfs/QmA', type: 'audio/webm' },
      { src: 'https://ipfs-3speak.b-cdn.net/ipfs/QmA', type: 'audio/webm' },
      { src: 'https://ipfs.io/ipfs/QmA', type: 'audio/webm' },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/api/audio?a=aud1`);
  });

  it('an m4a without an MP3 copy plays as audio/mp4; an unknown format as MP3', async () => {
    answers[`${API}/api/audio`] = { format: 'm4a', audioUrl: 'https://gw.test/ipfs/QmA' };
    expect(await audioSources(API, 'aud1')).toEqual([{ src: 'https://gw.test/ipfs/QmA', type: 'audio/mp4' }]);
    answers[`${API}/api/audio`] = { audioUrl: 'https://gw.test/ipfs/QmB' };
    expect((await audioSources(API, 'aud2'))[0].type).toBe('audio/mpeg');
  });

  it('throws when the audio is gone or has no file (the playlist skips it)', async () => {
    await expect(audioSources(API, 'gone')).rejects.toThrow('Audio not found');
    answers[`${API}/api/audio`] = { format: 'mp3' };
    await expect(audioSources(API, 'empty')).rejects.toThrow('Audio has no file');
  });
});

describe('loadAudio', () => {
  const LIST = [{ src: 'https://a.test/1', type: 'audio/mpeg' }, { src: 'https://b.test/1', type: 'audio/mpeg' }];
  const load = (permlink = 'aud1') => loadAudio(player, { api: API, permlink, list: LIST, checker: CHECKER });

  it('plays the first source and opens both listen counters on the first play only', async () => {
    load();
    expect(player.src).toHaveBeenCalledWith(LIST[0]);
    expect(fetchMock).not.toHaveBeenCalled();
    player.state.paused = false;
    player.trigger('play');
    player.trigger('play');
    await flush();
    expect(posts(`${API}/api/audio/play-start`)).toEqual([{ permlink: 'aud1' }]);
    expect(posts(`${CHECKER}/audio/listen/start`)).toEqual([{ kind: 'audio', id: 'aud1', duration: 60, position: 0, source: 'embed' }]);
  });

  it('beats each counter on its own schedule while playing, and on pause', async () => {
    vi.useFakeTimers();
    load();
    player.state.paused = false;
    player.trigger('play');
    await flush();
    vi.advanceTimersByTime(3000);
    player.state.currentTime = 3;
    player.trigger('timeupdate');
    await flush();
    expect(posts(`${API}/api/audio/play-beat`)).toEqual([{ sid: 's1', token: 't1' }]);
    expect(posts(`${CHECKER}/audio/listen/beat`)).toHaveLength(1);
    player.state.paused = true;
    player.trigger('pause');
    await flush();
    expect(posts(`${API}/api/audio/play-beat`)).toHaveLength(2);
    expect(posts(`${CHECKER}/audio/listen/beat`).at(-1)).toMatchObject({ sid: 'l1', token: 'lt1', position: 3, rate: 1 });
  });

  it('stops beating the plays counter once it counted, and never beats when it wants encryption', async () => {
    answers[`${API}/api/audio/play-beat`] = { credited: true };
    load();
    player.trigger('play');
    await flush();
    player.trigger('pause');
    await flush();
    player.trigger('pause');
    await flush();
    expect(posts(`${API}/api/audio/play-beat`)).toHaveLength(1);

    answers[`${API}/api/audio/play-start`] = { sid: 's2', token: 't2', encrypted: true };
    load('aud2');
    player.trigger('play');
    await flush();
    player.trigger('pause');
    await flush();
    expect(posts(`${API}/api/audio/play-beat`)).toHaveLength(1);
  });

  it('a failing gateway moves on to the next source, at the same place, still playing', async () => {
    load();
    player.trigger('play');
    player.state.currentTime = 12;
    player.trigger('timeupdate');
    player.trigger('error');
    expect(player.error).toHaveBeenCalledWith(null);
    expect(player.src).toHaveBeenLastCalledWith(LIST[1]);
    expect(player.play).toHaveBeenCalled();
    player.state.currentTime = 0;
    player.trigger('loadedmetadata');
    expect(player.currentTime).toHaveBeenLastCalledWith(12);
    // No source left: the error stays.
    player.error.mockClear();
    player.trigger('error');
    expect(player.error).not.toHaveBeenCalled();
  });

  it('stopAudio credits what was heard and goes quiet', async () => {
    load();
    player.state.paused = false;
    player.trigger('play');
    await flush();
    player.state.currentTime = 8;
    player.trigger('timeupdate');
    stopAudio(player);
    await flush();
    const beats = posts(`${CHECKER}/audio/listen/beat`);
    expect(beats.at(-1).position).toBe(8);
    player.trigger('pause');
    player.trigger('error');
    await flush();
    expect(posts(`${CHECKER}/audio/listen/beat`)).toHaveLength(beats.length);
    expect(player.src).toHaveBeenCalledTimes(1);
  });
});
