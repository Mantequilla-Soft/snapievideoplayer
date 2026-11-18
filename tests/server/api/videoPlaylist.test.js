// Video playlists behind the video embed URL: /api/watch answers `videoPlaylist` for a
// playlist with videos in it, and /api/playlist lists the videos that play, in order.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb, testDb } from '../../helpers/mongo.js';
import { loadServer, stopServer } from './_helpers/loadServer.js';
import { installFetch, json } from './_helpers/fakeFetch.js';
import { seedEmbed, seedLegacy } from './_helpers/fixtures.js';

let app;
let db;
let fetchMock;
// Per test: Hive post titles by "author/permlink"; a function to fail the batch.
let titles;

beforeAll(async () => { app = await loadServer(); db = await testDb(); });
afterAll(async () => { await stopServer(); await closeTestDb(); });
beforeEach(async () => {
  await resetDb();
  titles = {};
  fetchMock = installFetch(async (url, init) => {
    if (url !== 'https://hive.test') return undefined;
    const body = JSON.parse(init.body);
    if (typeof titles === 'function') return titles();
    if (!Array.isArray(body)) return json({ result: { author: '', permlink: '' } });
    return json(body.map((q) => {
      const [author, permlink] = q.params;
      const t = titles[`${author}/${permlink}`];
      if (t && typeof t === 'object') return { id: q.id, result: { author, permlink, title: '', ...t } };
      return { id: q.id, result: t ? { author, permlink, title: t } : { author: '', permlink: '' } };
    }));
  });
});

// Each test uses its own playlist id: /api/playlist caches per playlist for 5 minutes.
const seedPlaylist = (id, items, doc = {}) => db.collection('playlists').insertOne({
  _id: id, owner: 'badadib', name: 'My videos', access: 'public',
  items: items.map(([author, permlink], position) => ({ author, permlink, position })), ...doc,
});
const seedAudio = (doc) => db.collection('embed-audio').insertOne({
  owner: 'badadib', permlink: 'aud1abcd', post_permlink: 'an-episode', status: 'published', ...doc,
});

describe('/api/watch for a playlist with videos', () => {
  it('answers videoPlaylist, owner/id', async () => {
    await seedEmbed({ permlink: 'asset1', hive_permlink: 'first-video' });
    await seedPlaylist('aaaaaaaa-0001', [['badadib', 'first-video']]);
    const res = await request(app).get('/api/watch?v=badadib/aaaaaaaa-0001');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video not found', videoPlaylist: 'badadib/aaaaaaaa-0001' });
  });

  it('a mixed playlist goes to this player; an audio-only one to the audio player', async () => {
    await seedEmbed({ permlink: 'asset1', hive_permlink: 'first-video' });
    await seedAudio();
    await seedPlaylist('aaaaaaaa-0002', [['badadib', 'an-episode'], ['badadib', 'first-video']]);
    await seedPlaylist('aaaaaaaa-0003', [['badadib', 'an-episode']]);
    expect((await request(app).get('/api/watch?v=badadib/aaaaaaaa-0002')).body.videoPlaylist).toBe('badadib/aaaaaaaa-0002');
    expect((await request(app).get('/api/watch?v=badadib/aaaaaaaa-0003')).body.audioEmbed)
      .toBe('https://audio.3speak.tv/play?list=aaaaaaaa-0003');
  });

  it('a playlist typed "audio" stays with the audio player', async () => {
    await seedEmbed({ permlink: 'asset1', hive_permlink: 'first-video' });
    await seedPlaylist('aaaaaaaa-0004', [['badadib', 'first-video']], { type: 'audio' });
    const res = await request(app).get('/api/watch?v=badadib/aaaaaaaa-0004');
    expect(res.body.audioEmbed).toBe('https://audio.3speak.tv/play?list=aaaaaaaa-0004');
  });
});

describe('/api/playlist', () => {
  it('lists the videos in playlist order, with Hive titles, thumbnails and durations', async () => {
    await seedLegacy({ permlink: 'old-one', title: 'Legacy title', duration: 120 });
    await seedEmbed({ permlink: 'asset2', hive_permlink: 'new-one', duration: 61 });
    titles = { 'badadib/new-one': 'From Hive' };
    await seedPlaylist('bbbbbbbb-0001', [['badadib', 'new-one'], ['badadib', 'old-one']]);
    const res = await request(app).get('/api/playlist?v=badadib/bbbbbbbb-0001');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toEqual({
      id: 'bbbbbbbb-0001', owner: 'badadib', name: 'My videos', audioApi: 'https://audio.3speak.tv',
      items: [
        { v: 'badadib/new-one', title: 'From Hive', thumbnail: 'https://img.test/thumb.jpg', duration: 61 },
        { v: 'badadib/old-one', title: 'Legacy title', thumbnail: expect.any(String), duration: 120 },
      ],
    });
    // One batched Hive request for every title.
    const hive = fetchMock.mock.calls.filter(([u]) => u === 'https://hive.test');
    expect(hive).toHaveLength(1);
    expect(JSON.parse(hive[0][1].body)).toHaveLength(2);
  });

  it('leaves out what does not play: no video, encoding, deleted, a banned creator', async () => {
    await seedEmbed({ permlink: 'ok1', hive_permlink: 'plays' });
    await seedEmbed({ permlink: 'enc1', hive_permlink: 'encoding', status: 'encoding' });
    await seedEmbed({ permlink: 'del1', hive_permlink: 'deleted', status: 'deleted' });
    await seedEmbed({ owner: 'ashenadib', permlink: 'ban1', hive_permlink: 'banned' });
    await seedAudio({ status: 'deleted' });
    await db.collection('contentcreators').insertOne({ username: 'ashenadib', banned: true });
    await seedPlaylist('bbbbbbbb-0002', [
      ['badadib', 'nothing'], ['badadib', 'encoding'], ['badadib', 'deleted'],
      ['badadib', 'an-episode'], ['ashenadib', 'banned'], ['badadib', 'plays'],
    ]);
    const res = await request(app).get('/api/playlist?v=badadib/bbbbbbbb-0002');
    expect(res.body.items.map((i) => i.v)).toEqual(['badadib/plays']);
  });

  it('an item named by its asset permlink (a short) gets the title of its linked Hive post', async () => {
    await seedEmbed({ permlink: 'shrt1abc', hive_permlink: 'my-short-post', short: true });
    titles = { 'badadib/my-short-post': 'My short' };
    await seedPlaylist('bbbbbbbb-0008', [['badadib', 'shrt1abc']]);
    const res = await request(app).get('/api/playlist?v=badadib/bbbbbbbb-0008');
    expect(res.body.items).toEqual([expect.objectContaining({ v: 'badadib/shrt1abc', title: 'My short' })]);
  });

  it('a snap (no title) is named by the first line of its text', async () => {
    await seedEmbed({ permlink: 'snap2abc', hive_permlink: 'nlmac2-post' });
    titles = { 'badadib/nlmac2-post': { body: '![x](https://img.test/a.png)\n\n## **NLMAC2** - [What is on](https://x.test) 3/15\n\nMore text https://play.3speak.tv/watch?v=a/b' } };
    await seedPlaylist('bbbbbbbb-0010', [['badadib', 'snap2abc']]);
    const res = await request(app).get('/api/playlist?v=badadib/bbbbbbbb-0010');
    expect(res.body.items[0].title).toBe('NLMAC2 - What is on 3/15');
  });

  it('a post without a title or text falls back to the uploaded file name', async () => {
    await seedEmbed({ permlink: 'snap1abc', hive_permlink: '20261105t225357093z', originalFilename: 'VjingGodOfColors.mp4', embed_title: 'Comment' });
    await seedPlaylist('bbbbbbbb-0009', [['badadib', 'snap1abc']]);
    const res = await request(app).get('/api/playlist?v=badadib/bbbbbbbb-0009');
    expect(res.body.items[0].title).toBe('VjingGodOfColors');
  });

  it('falls back to the permlink when Hive is down, and keeps working', async () => {
    titles = () => { throw new Error('offline'); };
    await seedEmbed({ permlink: 'asset3', hive_permlink: 'no-title' });
    await seedPlaylist('bbbbbbbb-0003', [['badadib', 'no-title']]);
    const res = await request(app).get('/api/playlist?v=badadib/bbbbbbbb-0003');
    expect(res.status).toBe(200);
    expect(res.body.items[0].title).toBe('clip');
  });

  it('404 for a private playlist, another owner, a banned owner, or one with no playable video', async () => {
    await seedEmbed({ permlink: 'asset4', hive_permlink: 'v4' });
    await seedPlaylist('bbbbbbbb-0004', [['badadib', 'v4']], { access: 'private' });
    await seedPlaylist('bbbbbbbb-0005', [['badadib', 'v4']], { owner: 'ashenadib' });
    await seedPlaylist('bbbbbbbb-0006', [['badadib', 'gone']]);
    for (const id of ['bbbbbbbb-0004', 'bbbbbbbb-0005', 'bbbbbbbb-0006']) {
      const res = await request(app).get(`/api/playlist?v=badadib/${id}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Playlist not found' });
    }
    await db.collection('contentcreators').insertOne({ username: 'badadib', hidden: true });
    await seedPlaylist('bbbbbbbb-0007', [['badadib', 'v4']]);
    expect((await request(app).get('/api/playlist?v=badadib/bbbbbbbb-0007')).status).toBe(404);
  });

  it('a mixed playlist lists its audio too, in order, as audio items', async () => {
    await seedEmbed({ permlink: 'asset5', hive_permlink: 'a-video', duration: 30 });
    await seedAudio({ permlink: 'aud5abcd', post_permlink: 'badadib/an-episode', title: 'Upload name', duration: 99.6, thumbnail_url: 'https://img.test/cover.jpg' });
    await seedAudio({ permlink: 'aud6abcd', post_permlink: 'a-reply-track', title: 'Track two', duration: 0, mp3_duration: 61 });
    titles = { 'badadib/an-episode': 'Episode one', 'badadib/a-reply-track': 'RE: The album' };
    await seedPlaylist('bbbbbbbb-0011', [['badadib', 'an-episode'], ['badadib', 'a-video'], ['badadib', 'a-reply-track']],
      { thumbnail: 'https://img.test/list.jpg' });
    const res = await request(app).get('/api/playlist?v=badadib/bbbbbbbb-0011');
    expect(res.body.items).toEqual([
      { v: 'badadib/an-episode', kind: 'audio', audio: 'aud5abcd', title: 'Episode one', thumbnail: 'https://img.test/cover.jpg', duration: 100 },
      expect.objectContaining({ v: 'badadib/a-video' }),
      // A reply has no title of its own: the upload's. No cover: the playlist's.
      { v: 'badadib/a-reply-track', kind: 'audio', audio: 'aud6abcd', title: 'Track two', thumbnail: 'https://img.test/list.jpg', duration: 61 },
    ]);
    // Titles of videos and audio in the one Hive batch.
    const hive = fetchMock.mock.calls.filter(([u]) => u === 'https://hive.test');
    expect(hive).toHaveLength(1);
    expect(JSON.parse(hive[0][1].body)).toHaveLength(3);
  });

  it('an audio named by its own permlink, listed twice, plays once; a banned creator\'s audio is left out', async () => {
    await seedEmbed({ permlink: 'asset6', hive_permlink: 'b-video' });
    await seedAudio({ permlink: 'aud7abcd', post_permlink: 'ep-seven', title: 'Seven' });
    await seedAudio({ owner: 'ashenadib', permlink: 'aud8abcd', post_permlink: 'ep-eight' });
    await db.collection('contentcreators').insertOne({ username: 'ashenadib', hidden: true });
    await seedPlaylist('bbbbbbbb-0012', [['badadib', 'aud7abcd'], ['badadib', 'b-video'], ['badadib', 'ep-seven'], ['ashenadib', 'ep-eight']]);
    const res = await request(app).get('/api/playlist?v=badadib/bbbbbbbb-0012');
    expect(res.body.items.map((i) => i.v)).toEqual(['badadib/aud7abcd', 'badadib/b-video']);
  });

  it('audio alone is no playlist for this player (the audio player plays it)', async () => {
    await seedAudio();
    await seedPlaylist('bbbbbbbb-0013', [['badadib', 'an-episode']]);
    expect((await request(app).get('/api/playlist?v=badadib/bbbbbbbb-0013')).status).toBe(404);
  });

  it('400 without owner/id', async () => {
    expect((await request(app).get('/api/playlist?v=badadib')).status).toBe(400);
  });
});
