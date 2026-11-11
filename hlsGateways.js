/**
 * Which gateway each HLS segment loads from (used by /hls and /seg in server.js).
 *
 * When the IPFS network cannot find a CID's blocks (new uploads not announced:
 * 2026-09-30, again 2026-11-09), Bunny answers for the playlists and for whatever
 * segments it cached earlier, and hangs or trickles (first bytes at once, then
 * ~35 KB/s) on the rest. ipfs-audio.3speak.tv sits on the node the encoders upload
 * to and has every file, with CORS.
 *
 * Bunny's cache is mixed segment by segment, so one segment says nothing about the
 * next (and probing a segment makes Bunny cache it). So /hls points every segment
 * at /seg, and /seg decides for that ONE segment: Bunny gets the last PROBE_BYTES within
 * probeMs; if it has not passed by hedgeMs, ipfs-audio is asked in parallel, and
 * the player is redirected to whichever works. Bunny wins whenever it passes.
 * Answers are cached per segment, and concurrent requests share one decision.
 *
 * Archived videos (issue #54) live in ONE Buttercloud S3 bucket of ours, served by
 * a Bunny zone (S3_CDN_HOST) and straight from s3.3speak.tv when Bunny is down or
 * out of credit. Both send CORS. The bucket is checked as well as the host: S3
 * paths are names, not hashes, so another bucket on s3.3speak.tv could hold
 * anything under a CID's name. S3_BUCKET unset turns S3 off.
 */

const FALLBACK_GATEWAYS = ['https://ipfs-audio.3speak.tv'];

// Gateways /seg may send a player to. All send `Access-Control-Allow-Origin: *`.
const SEGMENT_HOSTS = new Set([
  'ipfs-3speak.b-cdn.net',
  'hotipfs-3speak-1.b-cdn.net',
  'ipfs-audio.3speak.tv',
]);

const S3_DIRECT_HOST = 's3.3speak.tv';
const S3_CDN_HOST = (process.env.S3_CDN_HOST || 'buttercloud.b-cdn.net').trim().toLowerCase();
const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,62}$/.test(process.env.S3_BUCKET || '') ? process.env.S3_BUCKET : '';

const envNum = (name, fallback, min) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
};

const DEFAULTS = {
  // Enough to tell a working gateway (~1 MB/s and up) from a trickle (tens of
  // KB/s): 256 KB in 1.5s is ~170 KB/s, below what even 480p needs to play. A
  // cached segment does it in ~0.1s.
  probeBytes: envNum('SEGMENT_PROBE_BYTES', 256 * 1024, 1024),
  probeMs: envNum('SEGMENT_PROBE_TIMEOUT_MS', 1500, 200),
  // ipfs-audio is asked once Bunny has not passed after this long, so a slow
  // Bunny costs ~hedgeMs + the fallback's time, not probeMs + it.
  hedgeMs: envNum('SEGMENT_HEDGE_MS', 700, 0),
  fallbackProbeMs: envNum('SEGMENT_FALLBACK_PROBE_TIMEOUT_MS', 3000, 200),
  cacheMs: 10 * 60 * 1000,
  // Nobody answered: send the player to the original, look again soon.
  missCacheMs: 60 * 1000,
  maxEntries: 20000,
};

function gatewayOf(url) {
  const m = String(url || '').match(/^(https:\/\/[^/]+)\/ipfs\//i);
  return m ? m[1] : null;
}

const isPlaylistUrl = (url) => /\.m3u8(\?|$)/i.test(String(url || ''));

// `{ host, cidPath }` for `https://<S3 host>/<S3_BUCKET>/<cid>/<file>`, else null.
// Read from the parsed URL, so `..` cannot climb out of the bucket. The query is
// dropped: the bucket is public, and Bunny ignores it anyway.
function s3Parts(url) {
  if (!S3_BUCKET) return null;
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
  if (host !== S3_CDN_HOST && host !== S3_DIRECT_HOST) return null;
  const prefix = `/${S3_BUCKET}/`;
  if (!u.pathname.startsWith(prefix)) return null;
  const cidPath = u.pathname.slice(prefix.length);
  return /^[^/]+\/./.test(cidPath) ? { host, cidPath } : null;
}

// The same object on another S3 host, or null if it would not pass s3Parts.
function s3Url(host, cidPath) {
  const p = s3Parts(`https://${host}/${S3_BUCKET}/${cidPath}`);
  return p ? `https://${p.host}/${S3_BUCKET}/${p.cidPath}` : null;
}

// A segment (or init map / key) on one of our CORS gateways: what /hls hands to
// /seg and the only thing /seg will redirect for.
function isSegmentUrl(url) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (isPlaylistUrl(url)) return false;
  if (s3Parts(url)) return true;
  return u.protocol === 'https:'
    && SEGMENT_HOSTS.has(u.hostname)
    && /^\/ipfs\/[^/]+\/./.test(u.pathname);
}

// The /seg address for a segment. The path ends in the segment's own file name:
// players such as ExoPlayer pick the container from the extension.
function segmentRouteUrl(selfBase, url) {
  let name = new URL(url).pathname.split('/').pop() || 'segment';
  try { name = decodeURIComponent(name); } catch (_) { /* keep it encoded */ }
  name = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${selfBase}/seg/${name}?u=${encodeURIComponent(url)}`;
}

// True when the gateway delivers the LAST `bytes` of the file (or all of a
// smaller one) within `timeoutMs`. The end, because IPFS stores a file as 256 KB
// blocks and the node behind Bunny often holds the first ones from a player that
// gave up halfway: the start comes at once and the rest never does (seen on
// 2026-11-09). A gateway that ignores Range and sends the whole file is cut off
// once enough has arrived.
async function probe(url, timeoutMs, fetchImpl, bytes) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let reader = null;
  try {
    const r = await fetchImpl(url, { redirect: 'follow', signal: ac.signal, headers: { Range: `bytes=-${bytes}` } });
    if (!r.ok) return false;
    if (!r.body?.getReader) return true; // nothing to time; the headers came in time
    reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      got += value ? value.byteLength : 0;
      if (got >= bytes) return true;
    }
  } catch (_) {
    return false; // includes the abort when time ran out mid-body
  } finally {
    clearTimeout(timer);
    if (reader) { try { await reader.cancel(); } catch (_) { /* already closed */ } }
  }
}

/**
 * Returns `route(url, { s3 })`, resolving to the address a player should fetch the
 * segment `url` from: `url` itself, or the same path on a fallback. `s3` says the
 * video has a copy in the bucket, which an IPFS segment can then fall back to.
 */
function createSegmentRouter(opts = {}) {
  const o = { ...DEFAULTS, fallbacks: FALLBACK_GATEWAYS, fetchImpl: (...a) => fetch(...a), now: Date.now, ...opts };
  const cache = new Map(); // segment url -> { target, until }
  const inflight = new Map(); // segment url -> Promise<target>

  const remember = (url, target, ms) => {
    cache.delete(url);
    cache.set(url, { target, until: o.now() + ms });
    while (cache.size > o.maxEntries) cache.delete(cache.keys().next().value);
  };

  // Where else this segment can come from, best first. On the S3 zone: the bucket
  // itself. On a Bunny IPFS zone: the bucket (if the video has a copy there), then
  // ipfs-audio. Already on a last resort: nowhere, so it is not probed.
  function alternatesFor(url, s3) {
    const inBucket = s3Parts(url);
    if (inBucket) return inBucket.host === S3_CDN_HOST ? [s3Url(S3_DIRECT_HOST, inBucket.cidPath)] : [];
    const own = gatewayOf(url);
    if (!own || o.fallbacks.includes(own)) return [];
    const ipfs = o.fallbacks.map((g) => g + url.slice(own.length));
    if (!s3) return ipfs;
    const cidPath = new URL(url).pathname.replace(/^\/ipfs\//, '');
    return [s3Url(S3_CDN_HOST, cidPath), s3Url(S3_DIRECT_HOST, cidPath), ...ipfs].filter(Boolean);
  }

  async function findFallback(alts) {
    for (const alt of alts) {
      if (await probe(alt, o.fallbackProbeMs, o.fetchImpl, o.probeBytes)) return alt;
    }
    return null;
  }

  async function decide(key, url, alts) {
    let fallback = null;
    const startFallback = () => (fallback ||= findFallback(alts));
    const hedge = setTimeout(startFallback, o.hedgeMs);
    const ok = await probe(url, o.probeMs, o.fetchImpl, o.probeBytes);
    clearTimeout(hedge);
    if (ok) return remember(key, url, o.cacheMs) || url;
    const alt = await startFallback();
    if (alt) return remember(key, alt, o.cacheMs) || alt;
    return remember(key, url, o.missCacheMs) || url;
  }

  return async function route(url, { s3 = false } = {}) {
    const alts = alternatesFor(url, s3);
    if (!alts.length) return url;
    // The flag changes the answer, so it is part of the key.
    const key = s3 ? `${url}|s3` : url;
    const known = cache.get(key);
    if (known && known.until > o.now()) return known.target;
    if (inflight.has(key)) return inflight.get(key);
    const p = decide(key, url, alts).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}

module.exports = {
  FALLBACK_GATEWAYS,
  SEGMENT_HOSTS,
  S3_BUCKET,
  S3_CDN_HOST,
  S3_DIRECT_HOST,
  gatewayOf,
  isPlaylistUrl,
  s3Parts,
  s3Url,
  isSegmentUrl,
  segmentRouteUrl,
  createSegmentRouter,
};
