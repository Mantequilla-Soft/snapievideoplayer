/**
 * Which gateway a media playlist's segments load from (used by /hls in server.js).
 *
 * When the IPFS network cannot find a CID's blocks (new uploads not announced:
 * 2026-09-30, again 2026-11-09), Bunny still answers for the playlists and the
 * first segments it cached earlier, then hangs on the rest: the video plays a few
 * seconds and spins forever. ipfs-audio.3speak.tv sits on the node the encoders
 * upload to and has every file, with CORS.
 *
 * So before /hls hands out a media playlist it asks the playlist's own gateway for
 * the LAST segment (the one least likely to be cached). If that does not answer
 * quickly and a fallback gateway does, every segment in the playlist points at the
 * fallback. The answer is kept per CID, so the other renditions of the same video
 * agree without probing again.
 */

const SEGMENT_FALLBACK_GATEWAYS = ['https://ipfs-audio.3speak.tv'];

const envMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 500 ? n : fallback;
};

const DEFAULTS = {
  probeMs: envMs('SEGMENT_PROBE_TIMEOUT_MS', 3000),
  fallbackProbeMs: envMs('SEGMENT_FALLBACK_PROBE_TIMEOUT_MS', 8000),
  cacheMs: 10 * 60 * 1000,
  // Nothing answered: keep the playlist's own gateway, but look again soon.
  missCacheMs: 60 * 1000,
  maxEntries: 5000,
};

const isMediaPlaylist = (text) => /#EXTINF/i.test(String(text || ''));

function lastSegmentRef(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t && !t.startsWith('#')) return t;
  }
  return null;
}

function gatewayOf(url) {
  const m = String(url || '').match(/^(https:\/\/[^/]+)\/ipfs\//i);
  return m ? m[1] : null;
}

function cidOf(url) {
  const m = String(url || '').match(/^https:\/\/[^/]+\/ipfs\/([^/?#]+)/i);
  return m ? m[1] : null;
}

// True when the gateway starts sending the file within `timeoutMs`. One byte is
// asked for, and the body is dropped as soon as the headers are in.
async function probe(url, timeoutMs, fetchImpl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { redirect: 'follow', signal: ac.signal, headers: { Range: 'bytes=0-0' } });
    try { await r.body?.cancel?.(); } catch (_) { /* nothing to free */ }
    return r.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns `pick(playlistUrl, text)`, resolving to the gateway origin (e.g.
 * "https://ipfs-audio.3speak.tv") the playlist's segments should use. Anything it
 * cannot reason about (a master, no /ipfs/ url, segments on another host) keeps
 * the playlist's own gateway.
 */
function createSegmentGatewayPicker(opts = {}) {
  const {
    fetchImpl = (...a) => fetch(...a),
    fallbacks = SEGMENT_FALLBACK_GATEWAYS,
    probeMs = DEFAULTS.probeMs,
    fallbackProbeMs = DEFAULTS.fallbackProbeMs,
    cacheMs = DEFAULTS.cacheMs,
    missCacheMs = DEFAULTS.missCacheMs,
    maxEntries = DEFAULTS.maxEntries,
    now = Date.now,
  } = opts;
  const cache = new Map(); // cid -> { gateway, until }

  const remember = (cid, gateway, ms) => {
    cache.delete(cid);
    cache.set(cid, { gateway, until: now() + ms });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  };

  return async function pick(playlistUrl, text) {
    const own = gatewayOf(playlistUrl);
    if (!own || !isMediaPlaylist(text)) return own;
    const ref = lastSegmentRef(text);
    if (!ref) return own;
    let target;
    try { target = new URL(ref, playlistUrl).href; } catch (_) { return own; }
    if (gatewayOf(target) !== own) return own;

    const cid = cidOf(playlistUrl);
    const known = cache.get(cid);
    if (known && known.until > now()) return known.gateway;

    if (await probe(target, probeMs, fetchImpl)) {
      remember(cid, own, cacheMs);
      return own;
    }
    for (const g of fallbacks) {
      if (g === own) continue;
      if (await probe(g + target.slice(own.length), fallbackProbeMs, fetchImpl)) {
        remember(cid, g, cacheMs);
        return g;
      }
    }
    remember(cid, own, missCacheMs);
    return own;
  };
}

module.exports = {
  SEGMENT_FALLBACK_GATEWAYS,
  isMediaPlaylist,
  lastSegmentRef,
  gatewayOf,
  cidOf,
  createSegmentGatewayPicker,
};
