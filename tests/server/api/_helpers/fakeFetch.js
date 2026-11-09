// A stand-in for global fetch. `routes` is a function (url, init) => Response |
// Promise<Response> | undefined; undefined falls through to a 404. Every call is
// recorded on the returned mock, so tests can assert which upstreams were asked.
import { vi } from 'vitest';

export function installFetch(routes = () => undefined) {
  const fn = vi.fn(async (url, init = {}) => {
    const r = await routes(String(url), init);
    return r || new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** The URLs fetch was called with, in order. */
export const calledUrls = (fn) => fn.mock.calls.map(([u]) => String(u));

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export const text = (body, status = 200, headers = {}) => new Response(body, { status, headers });

/** Never answers; rejects when the caller aborts (as real fetch does). */
export function hang(init) {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** The [author, permlink] a Hive condenser_api.get_content call asked for. */
export function hiveParams(init) {
  try { return JSON.parse(init.body).params; } catch { return null; }
}

/** A Hive get_content answer for a post whose json_metadata is `meta`. */
export function hivePost(author, permlink, meta) {
  return json({
    jsonrpc: '2.0',
    id: 1,
    result: { author, permlink, json_metadata: typeof meta === 'string' ? meta : JSON.stringify(meta) },
  });
}
