// Records every fetch and answers through a handler. Never touches the network.
import { vi } from 'vitest';

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * handler(url, opts) may return a Response, a plain value (sent as JSON),
 * an Error (thrown, like a network failure) or a Promise of any of those.
 */
export function stubFetch(handler = () => jsonResponse({})) {
  const calls = [];
  const fn = vi.fn(async (url, opts = {}) => {
    let body = opts.body;
    try { body = typeof body === 'string' ? JSON.parse(body) : body; } catch { /* not JSON */ }
    calls.push({ url: String(url), opts, body });
    const out = await handler(String(url), opts);
    if (out instanceof Error) throw out;
    if (out instanceof Response) return out;
    return jsonResponse(out);
  });
  vi.stubGlobal('fetch', fn);
  return {
    fn,
    calls,
    to(fragment) { return calls.filter((c) => c.url.includes(fragment)); },
  };
}

/** Let pending promise callbacks run (fetch().then chains). */
export async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
