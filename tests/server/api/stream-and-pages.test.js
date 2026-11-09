// GET /api/stream (live OpenPods rooms), the page routes, CORS and the 404 handler.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { closeTestDb } from '../../helpers/mongo.js';
import { loadServer, stopServer, ROOT } from './_helpers/loadServer.js';
import { installFetch, calledUrls, json, hiveParams, hivePost } from './_helpers/fakeFetch.js';

// From STREAM_ENDPOINTS in loadServer.js. The middle entry has no LiveKit URL and
// must be ignored; the trailing slash on the second API is trimmed.
const EP1 = 'https://hangouts.test';
const EP2 = 'https://hangouts2.test';

let app;

beforeAll(async () => { app = await loadServer(); });
afterAll(async () => { await stopServer(); await closeTestDb(); });

/** Endpoint answers: rooms[api][name] = room json, streams[api] = list. */
function streamServers({ rooms = {}, streams = {}, hive = null } = {}) {
  return installFetch((url, init) => {
    if (url === 'https://hive.test') return hive ? hive(hiveParams(init)) : json({ result: {} });
    for (const api of [EP1, EP2]) {
      if (url === `${api}/streams`) return streams[api] ? json(streams[api]) : json({ error: 'x' }, 500);
      if (url.startsWith(`${api}/rooms/`)) {
        const name = decodeURIComponent(url.slice(`${api}/rooms/`.length));
        const room = rooms[api]?.[name];
        return room ? json(room) : json({ error: 'not found' }, 404);
      }
    }
    return undefined;
  });
}

describe('GET /api/stream', () => {
  it('400 without v or room', async () => {
    installFetch();
    const res = await request(app).get('/api/stream');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ found: false, error: 'missing v' });
  });

  it('finds a live standalone room on the first endpoint', async () => {
    const f = streamServers({
      rooms: { [EP1]: { myroom: { mode: 'standalone', host: 'badadib', title: 'Live now', backgroundImage: 'https://img.test/bg.jpg', headless: true, watermark: true } } },
      streams: { [EP1]: [{ name: 'myroom', live: true }] },
    });
    const res = await request(app).get('/api/stream?v=myroom');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      found: true,
      live: true,
      roomName: 'myroom',
      api: EP1,
      lk: 'wss://lk1.test',
      host: 'badadib',
      title: 'Live now',
      thumbnail: 'https://img.test/bg.jpg',
      watermark: true,
    });
    expect(calledUrls(f)).toEqual([`${EP1}/streams`, `${EP1}/rooms/myroom`]);
    expect(f.mock.calls[0][1].headers).toEqual({ Accept: 'application/json' });
  });

  it('fills host, title and thumbnail from the live list when the room lacks them', async () => {
    streamServers({
      rooms: { [EP1]: { r2: { mode: 'standalone', headless: true } } },
      streams: { [EP1]: [{ name: 'r2', live: false, host: 'viewer1', title: 'From list', thumbnail: 'https://img.test/t.jpg' }] },
    });
    const res = await request(app).get('/api/stream?room=r2');
    expect(res.body).toMatchObject({
      found: true, live: false, host: 'viewer1', title: 'From list', thumbnail: 'https://img.test/t.jpg', watermark: false,
    });
  });

  it('reads title and thumbnail from the room post', async () => {
    streamServers({ rooms: { [EP1]: { r3: { mode: 'standalone', post: { title: 'Post title', thumbnail: 'https://img.test/p.jpg' } } } } });
    const res = await request(app).get('/api/stream?v=r3');
    expect(res.body).toMatchObject({ found: true, live: false, host: null, title: 'Post title', thumbnail: 'https://img.test/p.jpg' });
  });

  it('empty strings when nothing names the stream', async () => {
    streamServers({ rooms: { [EP1]: { r4: { mode: 'standalone' } } } });
    const res = await request(app).get('/api/stream?v=r4');
    expect(res.body).toMatchObject({ host: null, title: '', thumbnail: '', watermark: false });
  });

  it('tries the full id, then its last path segment', async () => {
    const f = streamServers({ rooms: { [EP1]: { room9: { mode: 'standalone' } } } });
    const res = await request(app).get('/api/stream?v=badadib/room9');
    expect(res.body).toMatchObject({ found: true, roomName: 'room9' });
    expect(calledUrls(f)).toEqual([`${EP1}/streams`, `${EP1}/rooms/badadib%2Froom9`, `${EP1}/rooms/room9`]);
  });

  it('moves on to the next endpoint, skipping the malformed one', async () => {
    const f = streamServers({ rooms: { [EP2]: { other: { mode: 'standalone', host: 'badadib' } } } });
    const res = await request(app).get('/api/stream?v=other');
    expect(res.body).toMatchObject({ found: true, api: EP2, lk: 'wss://lk2.test', host: 'badadib' });
    expect(calledUrls(f)).toEqual([`${EP1}/streams`, `${EP1}/rooms/other`, `${EP2}/streams`, `${EP2}/rooms/other`]);
  });

  it('ignores a room that is not a standalone stream', async () => {
    streamServers({ rooms: { [EP1]: { hang: { mode: 'hangout' } } } });
    const res = await request(app).get('/api/stream?v=hang');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ found: false });
  });

  it('survives endpoints that are down', async () => {
    installFetch(() => { throw new Error('ECONNREFUSED'); });
    const res = await request(app).get('/api/stream?v=anything');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ found: false });
  });

  it('a bare id with no room is never looked up on Hive', async () => {
    const f = streamServers();
    await request(app).get('/api/stream?v=lonely');
    expect(calledUrls(f)).not.toContain('https://hive.test');
  });

  it('404 endedStream when the id is a Hive stream post whose room is gone', async () => {
    let asked;
    const f = streamServers({
      hive: (params) => { asked = params; return hivePost('badadib', 'stream-post', { video: { live: true } }); },
    });
    const res = await request(app).get('/api/stream?v=badadib/stream-post');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ found: false, endedStream: true });
    expect(asked).toEqual(['badadib', 'stream-post']);
    const [, init] = f.mock.calls.find(([u]) => u === 'https://hive.test');
    expect(JSON.parse(init.body).method).toBe('condenser_api.get_content');
  });

  it.each([
    ['an ordinary video post', () => hivePost('badadib', 'p', { video: { duration: 10 } })],
    ['metadata that is not JSON', () => hivePost('badadib', 'p', 'nope{')],
    ['an empty post', () => json({ result: { author: '' } })],
    ['a Hive HTTP error', () => json({}, 500)],
    ['a Hive network error', () => { throw new Error('reset'); }],
  ])('plain 404 for %s', async (_label, hive) => {
    streamServers({ hive });
    const res = await request(app).get('/api/stream?v=badadib/p');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ found: false });
  });
});

describe('page routes', () => {
  const distHas = (f) => fs.existsSync(path.join(ROOT, 'dist', f));

  it.each(['/watch', '/embed', '/play'])('%s without v or live redirects to the landing page', async (route) => {
    const res = await request(app).get(route);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it.each(['/watch?v=badadib/clip', '/embed?v=badadib/clip', '/play?v=badadib/clip', '/watch?live=room1', '/embed?room=room1'])(
    '%s serves the player page',
    async (url) => {
      const res = await request(app).get(url);
      // dist/ only exists after a build; without it sendFile fails with a 404.
      if (distHas('index.html')) {
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
      } else {
        expect(res.status).toBe(404);
      }
      expect(res.headers.location).toBeUndefined();
    },
  );

  it('/ serves the landing page from dist', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(distHas('landing.html') ? 200 : 404);
  });

  it('/debug-mobile.html is served from the repo root', async () => {
    const res = await request(app).get('/debug-mobile.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toBe(fs.readFileSync(path.join(ROOT, 'debug-mobile.html'), 'utf8'));
  });
});

describe('CORS and fallbacks', () => {
  it('answers a preflight for any origin', async () => {
    const res = await request(app)
      .options('/api/view')
      .set('Origin', 'https://embedder.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('JSON 404 for an unknown API route', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('JSON 404 for an unknown file', async () => {
    const res = await request(app).get('/no-such-file-here.txt');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('JSON 404 for a POST nobody handles', async () => {
    const res = await request(app).post('/api/watch').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('400 for a malformed JSON body', async () => {
    const res = await request(app).post('/api/view').set('Content-Type', 'application/json').send('{"owner":');
    expect(res.status).toBe(400);
  });
});
