/**
 * Tells the embedding page where each playlist and segment really came from.
 *
 * The player's URLs hide the answer: playlists come through /hls, which picks a
 * gateway or the S3 bucket on the server, and segments go through /seg, which
 * redirects. A migrated video that has fallen back to IPFS plays just as well as
 * one playing from S3, so an embedding tool (the S3 migrator) asks the player.
 *
 * For every VHS response, the parent window gets:
 *   { type: '3speak-source', kind: 'playlist' | 'segment', url, proxied, confirmed, ok, status }
 *   url        where the bytes came from (the gateway or bucket URL, never ours)
 *   proxied    the bytes came through this server (/ipfs-proxy, or the /hls rewrite)
 *   confirmed  false only for a playlist whose /hls answer did not name its source
 * Only URLs a viewer could read in DevTools; nothing is sent outside an iframe.
 */

export const SOURCE_MESSAGE = '3speak-source';
export const SOURCE_HEADER = 'x-snapie-source';

const PLAYLIST_RE = /\.m3u8$/i;
const MEDIA_REQUESTS = new Set(['hls-playlist', 'segment']);

function headerOf(request, response, name) {
  const h = response && response.headers;
  if (h && typeof h[name] === 'string') return h[name];
  try {
    return (request && typeof request.getResponseHeader === 'function' && request.getResponseHeader(name)) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Describe one finished request, or null when it isn't media (or not a URL).
 * `selfOrigin` resolves relative URLs. /hls, /seg and /ipfs-proxy are known by path
 * alone, since PUBLIC_BASE_URL need not be the page's origin; a gateway or bucket URL
 * always has /ipfs/… or /<bucket>/<cid>/… there instead.
 */
export function describeResponse(request, error, response, selfOrigin) {
  // Only playlists and media segments say where the video plays from: keys, init
  // maps and steering manifests can sit elsewhere. VHS tags each request; an
  // untagged one (an older VHS) is classified by its URL below.
  const type = request && request.requestType;
  if (type && !MEDIA_REQUESTS.has(type)) return null;
  const raw = (request && request.responseURL) || (response && (response.responseUrl || response.url)) || (request && request.uri);
  let final;
  try { final = new URL(raw, selfOrigin); } catch (_) { return null; }
  const status = (response && response.statusCode) || (request && request.status) || 0;
  const ok = !error && (status === 200 || status === 206);
  const upstream = final.searchParams.get('u');

  if (/^\/hls(\/manifest\.m3u8)?$/.test(final.pathname)) {
    const named = headerOf(request, response, SOURCE_HEADER);
    return { kind: 'playlist', url: named || upstream, proxied: true, confirmed: !!named, ok, status };
  }
  if (final.pathname === '/ipfs-proxy') {
    // It may have served the bytes from another gateway than the one in u=.
    const named = headerOf(request, response, SOURCE_HEADER);
    return { kind: 'segment', url: named || upstream, proxied: true, confirmed: !!named, ok, status };
  }
  if (final.pathname.startsWith('/seg/')) {
    // Still on /seg: the redirect never happened (the request failed before it).
    return { kind: 'segment', url: upstream, proxied: false, confirmed: false, ok, status };
  }
  return {
    kind: PLAYLIST_RE.test(final.pathname) ? 'playlist' : 'segment',
    url: final.href, proxied: false, confirmed: true, ok, status,
  };
}

const installed = new WeakSet();

/**
 * Hook VHS's global response hooks once. `post` receives each report. Does nothing
 * when VHS has no hook API (an old VHS, or native HLS on iOS, where nothing is reported).
 */
export function installSourceReport(Vhs, post, selfOrigin) {
  const xhr = Vhs && Vhs.xhr;
  if (!xhr || typeof xhr.onResponse !== 'function' || installed.has(xhr)) return false;
  installed.add(xhr);
  xhr.onResponse((request, error, response) => {
    try {
      const report = describeResponse(request, error, response, selfOrigin);
      if (report && report.url) post({ type: SOURCE_MESSAGE, ...report });
    } catch (_) { /* reporting must never break playback */ }
  });
  return true;
}
