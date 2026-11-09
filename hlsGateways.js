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
 * the start of the LAST segment (the one least likely to be cached) and times it.
 * Bunny does not always go silent: it may send the first bytes at once and then
 * trickle at ~35 KB/s, so the probe reads PROBE_BYTES, not one byte, and a gateway
 * that cannot deliver them in time counts as failing. If the fallback does, every
 * segment in the playlist points at the fallback. Both are asked at once, so a
 * slow pair delays the playlist by the fallback's limit, not the sum. The answer is kept per CID, so the other renditions of the same video
 * agree without probing again.
 */

const SEGMENT_FALLBACK_GATEWAYS = ['https://ipfs-audio.3speak.tv'];

const envMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 500 ? n : fallback;
};

// Enough to tell a working gateway (~1 MB/s and up) from a trickle (tens of KB/s)
// within the probe's time (see probeMs below).
const PROBE_BYTES = (() => {
  const n = Number(process.env.SEGMENT_PROBE_BYTES);
  return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 256 * 1024;
})();

const DEFAULTS = {
  // A cached segment answers in ~0.1s; 1.5s for PROBE_BYTES is ~170 KB/s, below
  // what even 480p needs to play (1.8 Mbps), so a trickling gateway fails it.
  probeMs: envMs('SEGMENT_PROBE_TIMEOUT_MS', 1500),
  // Runs at the same time as the first probe, so this caps the wait for the
  // playlist when both gateways are slow.
  fallbackProbeMs: envMs('SEGMENT_FALLBACK_PROBE_TIMEOUT_MS', 4000),
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

// True when the gateway delivers the first `bytes` of the file (or all of a
// smaller one) within `timeoutMs`. A gateway that ignores Range and sends the
// whole file is cut off once enough has arrived.
async function probe(url, timeoutMs, fetchImpl, bytes = PROBE_BYTES) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let reader = null;
  try {
    const r = await fetchImpl(url, { redirect: 'follow', signal: ac.signal, headers: { Range: `bytes=0-${bytes - 1}` } });
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
    probeBytes = PROBE_BYTES,
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

    // All probes start together: the playlist waits at most the longest limit,
    // not their sum. The playlist's own gateway still wins whenever it passes.
    const ownOk = probe(target, probeMs, fetchImpl, probeBytes);
    const others = fallbacks
      .filter((g) => g !== own)
      .map((g) => probe(g + target.slice(own.length), fallbackProbeMs, fetchImpl, probeBytes).then((ok) => (ok ? g : null)));
    if (await ownOk) {
      remember(cid, own, cacheMs);
      return own;
    }
    for (const next of others) {
      const g = await next;
      if (g) {
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
  PROBE_BYTES,
  isMediaPlaylist,
  lastSegmentRef,
  gatewayOf,
  cidOf,
  createSegmentGatewayPicker,
};
