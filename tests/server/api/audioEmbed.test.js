// An audio or an audio playlist reached through the video embed URL: /api/watch and
// /api/embed still answer 404 (it is not a video), and say where it plays (audioEmbed).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb, testDb } from '../../helpers/mongo.js';
import { loadServer, stopServer } from './_helpers/loadServer.js';
import { installFetch, json } from './_helpers/fakeFetch.js';
import { seedEmbed } from './_helpers/fixtures.js';

const AUDIO = 'https://audio.3speak.tv/play';
const LIST_HEX = '0123456789abcdef0123456789abcdef';
const LIST_UUID = '0f8e4a3c-1b2d-4e5f-8a9b-0c1d2e3f4a5b';

let app;
let db;

beforeAll(async () => { app = await loadServer(); db = await testDb(); });
afterAll(async () => { await stopServer(); await closeTestDb(); });
beforeEach(async () => {
  await resetDb();
  installFetch(async () => json({ result: { author: '', permlink: '' } }));
});

const seedAudio = (doc) => db.collection('embed-audio').insertOne({
  owner: 'badadib', permlink: 'aud1abcd', post_permlink: 'my-podcast-ep-1', status: 'published', ...doc,
});
const seedPlaylist = (doc) => db.collection('playlists').insertOne({
  _id: LIST_HEX, owner: 'badadib', access: 'public', type: 'audio', items: [], ...doc,
});
const watch = (v) => request(app).get(`/api/watch?v=${v}`);

describe('audio behind a video link', () => {
  it('finds the audio by its Hive post permlink', async () => {
    await seedAudio();
    const res = await watch('badadib/my-podcast-ep-1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video not found', audioEmbed: `${AUDIO}?a=aud1abcd` });
  });

  it('finds it by the audio permlink, and through /api/embed too', async () => {
    await seedAudio();
    const res = await request(app).get('/api/embed?v=badadib/aud1abcd');
    expect(res.status).toBe(404);
    expect(res.body.audioEmbed).toBe(`${AUDIO}?a=aud1abcd`);
  });

  it('matches a post_permlink stored as "author/permlink"', async () => {
    await seedAudio({ post_permlink: 'badadib/my-podcast-ep-1' });
    expect((await watch('badadib/my-podcast-ep-1')).body.audioEmbed).toBe(`${AUDIO}?a=aud1abcd`);
  });

  it('ignores another owner and unpublished audio', async () => {
    await seedAudio({ owner: 'ashenadib' });
    await seedAudio({ permlink: 'aud2abcd', post_permlink: 'draft', status: 'uploading' });
    expect((await watch('badadib/my-podcast-ep-1')).body).toEqual({ error: 'Video not found' });
    expect((await watch('badadib/draft')).body).toEqual({ error: 'Video not found' });
  });

  it('a video with the same owner/permlink still plays as the video', async () => {
    await seedEmbed({ permlink: 'my-podcast-ep-1' });
    await seedAudio();
    const res = await request(app).get('/api/embed?v=badadib/my-podcast-ep-1');
    expect(res.status).toBe(200);
    expect(res.body.audioEmbed).toBeUndefined();
  });
});

describe('audio playlist behind a video link', () => {
  it('a public audio playlist, addressed owner/id', async () => {
    await seedPlaylist();
    const res = await watch(`badadib/${LIST_HEX}`);
    expect(res.status).toBe(404);
    expect(res.body.audioEmbed).toBe(`${AUDIO}?list=${LIST_HEX}`);
  });

  it('an untyped playlist counts when one of its items is an audio', async () => {
    await seedAudio();
    await seedPlaylist({ _id: LIST_UUID, type: undefined, items: [
      { author: 'ashenadib', permlink: 'some-video', position: 0 },
      { author: 'badadib', permlink: 'my-podcast-ep-1', position: 1 },
    ] });
    expect((await watch(`badadib/${LIST_UUID}`)).body.audioEmbed).toBe(`${AUDIO}?list=${LIST_UUID}`);
  });

  it('not a video playlist, an untyped one without audio, a private one or another owner', async () => {
    await seedPlaylist({ _id: LIST_UUID, type: 'video' });
    await seedPlaylist({ _id: 'aaaaaaaa-1111', type: undefined, items: [{ author: 'badadib', permlink: 'vid' }] });
    await seedPlaylist({ _id: 'bbbbbbbb-2222', access: 'private' });
    await seedPlaylist({ _id: 'cccccccc-3333', owner: 'ashenadib' });
    for (const id of [LIST_UUID, 'aaaaaaaa-1111', 'bbbbbbbb-2222', 'cccccccc-3333']) {
      expect((await watch(`badadib/${id}`)).body).toEqual({ error: 'Video not found' });
    }
  });
});
