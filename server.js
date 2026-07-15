const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
require('dotenv').config();

const db = require('./db');
const watchTracking = require('./watchTracking');

const app = express();
const PORT = process.env.PORT || 3005;

// Trust the nginx reverse proxy so req.ip reflects the real client IP
// (from X-Forwarded-For) instead of the loopback address.
app.set('trust proxy', true);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ============================================================================
// CONSTANTS
// ============================================================================

const VIDEO_STATUS = {
  // Deleted statuses
  DELETE: 'delete',
  DELETED: 'deleted',
  SELF_DELETED: 'self_deleted',
  
  // Processing statuses
  ENCODING_IPFS: 'encoding_ipfs',
  IPFS_PINNING: 'ipfs_pinning',
  UPLOADED: 'uploaded',
  
  // Failed statuses
  ENCODING_FAILED: 'encoding_failed',
  
  // Ready statuses
  PUBLISH_LATER: 'publish_later',
  PUBLISH_MANUAL: 'publish_manual',
  PUBLISHED: 'published',
  SCHEDULED: 'scheduled'
};

const PLACEHOLDER_TYPE = {
  PROCESSING: 'processing',
  FAILED: 'failed',
  DELETED: 'deleted'
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse and validate video parameter (owner/permlink)
 */
function parseVideoParams(videoParam) {
  if (!videoParam) {
    return { error: 'Missing video parameter (v)' };
  }
  
  const [owner, permlink] = videoParam.split('/');
  
  if (!owner || !permlink) {
    return { error: 'Invalid video format. Expected: owner/permlink' };
  }
  
  return { owner, permlink };
}

/**
 * Create placeholder URL object with all fallbacks pointing to same URL
 */
function createPlaceholderUrls(placeholderUrl) {
  return {
    primary: placeholderUrl,
    fallback1: placeholderUrl,
    fallback2: placeholderUrl,
    fallback3: placeholderUrl
  };
}

/**
 * Transform IPFS URL to gateway URL with fallback
 */
function transformIPFSUrl(ipfsUrl, useFallback = false) {
  const gateway = useFallback ? process.env.IPFS_GATEWAY_FALLBACK : process.env.IPFS_GATEWAY;
  
  if (ipfsUrl.startsWith('ipfs://')) {
    const cidPath = ipfsUrl.replace('ipfs://', '');
    return `${gateway}/${cidPath}`;
  }
  
  return ipfsUrl;
}

/**
 * Get gateway URLs with CDN-first fallback chain
 */
function getVideoUrls(ipfsUrl) {
  const gateways = {
    hotcdn: 'https://hotipfs-3speak-1.b-cdn.net/ipfs',   // BunnyCDN Hotnode (primary)
    cdn: 'https://ipfs-3speak.b-cdn.net/ipfs',         // BunnyCDN IPFS (fallback - legacy pullzone)
    supernode: 'https://ipfs.3speak.tv/ipfs',          // Supernode (direct IPFS)
    audionode: 'https://ipfs-audio.3speak.tv/ipfs'     // Audionode (backup)
  };
  
  if (ipfsUrl.startsWith('ipfs://')) {
    const cidPath = ipfsUrl.replace('ipfs://', '');
    return {
      primary: `${gateways.hotcdn}/${cidPath}`,
      fallback1: `${gateways.cdn}/${cidPath}`,
      fallback2: `${gateways.supernode}/${cidPath}`,
      fallback3: `${gateways.audionode}/${cidPath}`
    };
  }
  
  return {
    primary: ipfsUrl,
    fallback1: ipfsUrl,
    fallback2: ipfsUrl,
    fallback3: ipfsUrl
  };
}

// Public origin of this player (for building self-referential proxy URLs the browser
// can reach). Overridable via env; defaults to the preview host.
const SELF_BASE = (process.env.PUBLIC_BASE_URL || 'https://preview-player.okinoko.io').replace(/\/$/, '');

// Route an HLS master manifest through the /hls rewrite proxy below (which fixes the
// legacy-encoder codec bug on the fly). Non-m3u8 URLs pass through unchanged.
function proxiedManifest(url) {
  if (!url || typeof url !== 'string' || !/\.m3u8(\?|$)/i.test(url)) return url;
  return `${SELF_BASE}/hls?u=${encodeURIComponent(url)}`;
}

// True if a CODECS="..." string lists a video codec. Old 3Speak encodes wrongly
// declared audio only (mp4a) with no avc1, so strict players (Firefox/MSE) built an
// audio-only decoder and the video never rendered.
function codecsHaveVideo(codecs) {
  return /avc1|avc3|hvc1|hev1|vp0?9|av01|dvh1/i.test(codecs || '');
}

// IPFS gateways to try for a manifest, hot/primary first — same set as getVideoUrls().
// /hls races these so a video that migrated off the hot zone still plays, while one
// that's gone everywhere fails FAST instead of hanging on a dead gateway.
const HLS_GATEWAYS = [
  'https://hotipfs-3speak-1.b-cdn.net',
  'https://ipfs-3speak.b-cdn.net',
  'https://ipfs.3speak.tv',
  'https://ipfs-audio.3speak.tv',
];
// How long to wait for a gateway to return the master manifest before treating it as
// unavailable. The file itself is only a couple KB, but a video that has migrated to
// COLD IPFS can need a while to resolve the CID the first time (DHT lookup + fetch) —
// 5s was cutting off slow-but-alive gateways. Kept generous; env-tunable. NB: this
// only extends waits for gateways that HANG — a 404/502 (a genuinely dead video)
// still rejects fast, so the watch-page "unavailable" hint isn't much delayed.
const HLS_FETCH_TIMEOUT_MS = (() => {
  // Robust against a missing/blank/garbage/negative override — anything that isn't a
  // sane positive number (≥1s) falls back to the default rather than, say, a negative
  // that would fire the abort immediately and mark every video unavailable.
  const n = Number(process.env.HLS_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 15000;
})();

/**
 * GET /hls?u=<encoded upstream master .m3u8 URL>
 *
 * Two jobs in one tiny proxy:
 *  1. WORKAROUND for the legacy 3Speak encoder bug (~90% of pre-2026 videos): their
 *     HLS master declares CODECS="mp4a.40.2" (audio only) and omits the H.264 video
 *     codec, so strict players build an audio-only decoder and never render the video.
 *     ONLY when the master declares codecs without a video one, we strip the misleading
 *     CODECS attribute so the player detects the real codecs from the segments.
 *  2. GATEWAY RACE: try the hot zone first (the fast common path); if it's gone, race
 *     every other gateway in parallel and serve the first that answers. A video that
 *     migrated off the hot zone still plays, and one that's genuinely gone fails FAST
 *     with a 504 (short per-gateway timeout) instead of the old sequential per-gateway
 *     stall that could hang ~70s each and hide the "video no longer available" state
 *     behind a minutes-long spinner.
 *
 * Only the master is proxied; variant/segment refs are absolutised to the WINNING
 * gateway so they load straight from the CDN. Correct manifests pass through
 * byte-for-byte. Fail-open: a rewrite bug 302s to the reachable manifest.
 */
app.get('/hls', async (req, res) => {
  const upstream = String(req.query.u || '');
  // Only proxy https IPFS-gateway manifests — never an open redirector/SSRF vector.
  if (!/^https:\/\/[a-z0-9.-]+\/ipfs\//i.test(upstream) || !/\.m3u8(\?|$)/i.test(upstream)) {
    return res.status(400).send('bad manifest url');
  }
  // The path after /ipfs/ (CID + file) is gateway-independent — try it everywhere.
  const cidPath = upstream.replace(/^https:\/\/[^/]+\/ipfs\//i, '');
  const seen = new Set();
  const candidates = [];
  for (const gwBase of [upstream.replace(/\/ipfs\/.*$/i, ''), ...HLS_GATEWAYS]) {
    const u = `${gwBase}/ipfs/${cidPath}`;
    if (!seen.has(u)) { seen.add(u); candidates.push(u); }
  }

  const fetchManifest = async (u) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HLS_FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(u, { redirect: 'follow', signal: ac.signal });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const text = await r.text();
      if (!/#EXTM3U/.test(text)) throw new Error('not a manifest');
      return { url: u, text };
    } finally {
      clearTimeout(timer);
    }
  };

  let hit;
  try {
    hit = await fetchManifest(candidates[0]);          // hot zone — common, fast path
  } catch (_) {
    try {
      hit = await Promise.any(candidates.slice(1).map(fetchManifest)); // migrated? race the rest
    } catch (_) {
      // Every gateway failed → the media is genuinely unreachable. Fail FAST (a 504,
      // not a redirect to a hanging origin) so the player surfaces its fatal error and
      // the watch page can show the "no longer available" hint promptly.
      return res.status(504).send('manifest unreachable on all gateways');
    }
  }

  try {
    const base = hit.url.slice(0, hit.url.lastIndexOf('/') + 1);
    const abs = (u) => { try { return new URL(u, base).href; } catch { return u; } };
    const fixed = hit.text.split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (t.startsWith('#EXT-X-STREAM-INF')) {
        const m = t.match(/CODECS="([^"]*)"/i);
        if (m && !codecsHaveVideo(m[1])) return line.replace(/,?\s*CODECS="[^"]*"/i, '');
        return line;
      }
      // Relative URI="..." inside a tag (e.g. #EXT-X-MEDIA) → absolute.
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/i, (full, u) => (/^https?:\/\//i.test(u) ? full : `URI="${abs(u)}"`));
      }
      // A bare relative variant/segment reference → absolute winning-gateway URL.
      if (t && !/^https?:\/\//i.test(t)) return abs(t);
      return line;
    }).join('\n');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(fixed);
  } catch (_) {
    return res.redirect(302, hit.url); // rewrite bug, but this manifest was reachable
  }
});

/**
 * Convert thumbnail reference to CDN or HTTPS URL
 * Handles: HTTPS URLs (pass-through), IPFS CIDs (conversion), and missing values (fallback)
 */
function convertThumbnailToCdn(thumbnail) {
  // If already a full HTTPS URL, return as-is
  if (thumbnail && thumbnail.startsWith('https://')) {
    return thumbnail;
  }
  
  // If IPFS reference, convert to CDN
  if (thumbnail) {
    const cidPath = thumbnail.startsWith('ipfs://') 
      ? thumbnail.replace('ipfs://', '') 
      : thumbnail;
    return `https://hotipfs-3speak-1.b-cdn.net/ipfs/${cidPath}`;
  }
  
  // Fallback to default thumbnail
  return `https://hotipfs-3speak-1.b-cdn.net/ipfs/${process.env.DEFAULT_THUMBNAIL_CID}`;
}

/**
 * Convert video CID/URL to full CDN manifest URL (for mobile API)
 * Returns ready-to-play HTTPS URL with manifest.m3u8
 */
function convertToCdnUrl(ipfsUrl) {
  const cdnGateway = 'https://hotipfs-3speak-1.b-cdn.net/ipfs';
  
  if (ipfsUrl.startsWith('ipfs://')) {
    const cidPath = ipfsUrl.replace('ipfs://', '');
    // Ensure manifest.m3u8 is included for HLS
    if (!cidPath.includes('manifest.m3u8')) {
      return `${cdnGateway}/${cidPath}/manifest.m3u8`;
    }
    return `${cdnGateway}/${cidPath}`;
  }
  
  // If already a full URL, return as-is
  if (ipfsUrl.startsWith('https://')) {
    return ipfsUrl;
  }
  
  // Plain CID
  return `${cdnGateway}/${ipfsUrl}/manifest.m3u8`;
}

/**
 * Get placeholder video URL based on status
 */
function getPlaceholderVideo(placeholderType) {
  switch (placeholderType?.toLowerCase()) {
    case PLACEHOLDER_TYPE.PROCESSING:
    case 'uploading': // Legacy support
      return transformIPFSUrl(process.env.PLACEHOLDER_PROCESSING_CID);
    
    case PLACEHOLDER_TYPE.FAILED:
      return transformIPFSUrl(process.env.PLACEHOLDER_FAILED_CID);
    
    case PLACEHOLDER_TYPE.DELETED:
      return transformIPFSUrl(process.env.PLACEHOLDER_DELETED_CID);
    
    default:
      return null;
  }
}

/**
 * Determine video URLs based on status for legacy collection (videos)
 */
function getVideoUrlsForLegacyStatus(video) {
  const status = video.status?.toLowerCase() || '';
  
  // Deleted videos - serve deletion notice
  if ([VIDEO_STATUS.DELETE, VIDEO_STATUS.DELETED, VIDEO_STATUS.SELF_DELETED].includes(status)) {
    const placeholderUrl = getPlaceholderVideo(PLACEHOLDER_TYPE.DELETED);
    if (!placeholderUrl) {
      return { error: 'Placeholder configuration error', status: video.status };
    }
    return {
      urls: createPlaceholderUrls(placeholderUrl),
      isPlaceholder: true
    };
  }
  
  // Processing videos - serve processing notice
  if ([VIDEO_STATUS.ENCODING_IPFS, VIDEO_STATUS.IPFS_PINNING, VIDEO_STATUS.UPLOADED].includes(status)) {
    const placeholderUrl = getPlaceholderVideo(PLACEHOLDER_TYPE.PROCESSING);
    if (!placeholderUrl) {
      return { error: 'Placeholder configuration error', status: video.status };
    }
    return {
      urls: createPlaceholderUrls(placeholderUrl),
      isPlaceholder: true
    };
  }
  
  // Failed videos - serve failed notice
  if ([VIDEO_STATUS.ENCODING_FAILED, 'failed'].includes(status)) {
    const placeholderUrl = getPlaceholderVideo(PLACEHOLDER_TYPE.FAILED);
    if (!placeholderUrl) {
      return { error: 'Placeholder configuration error', status: video.status };
    }
    return {
      urls: createPlaceholderUrls(placeholderUrl),
      isPlaceholder: true
    };
  }
  
  // Ready videos - serve actual content
  if ([VIDEO_STATUS.PUBLISH_LATER, VIDEO_STATUS.PUBLISH_MANUAL, VIDEO_STATUS.PUBLISHED, VIDEO_STATUS.SCHEDULED].includes(status)) {
    if (!video.video_v2) {
      return { error: 'Video source not available', status: video.status };
    }
    return {
      urls: getVideoUrls(video.video_v2),
      isPlaceholder: false
    };
  }
  
  // Unknown status
  return { error: 'Video source not available', status: video.status };
}

/**
 * Determine video URLs based on status for embed collection (embed-video)
 */
function getVideoUrlsForEmbedStatus(video) {
  const status = video.status?.toLowerCase() || '';
  
  // Published videos with manifest - serve actual content
  if (status === VIDEO_STATUS.PUBLISHED && video.manifest_cid) {
    return {
      urls: getVideoUrls(`ipfs://${video.manifest_cid}/manifest.m3u8`),
      isPlaceholder: false
    };
  }
  
  // All other statuses - determine appropriate placeholder
  let placeholderType = null;
  
  if ([VIDEO_STATUS.DELETE, VIDEO_STATUS.DELETED, VIDEO_STATUS.SELF_DELETED].includes(status)) {
    placeholderType = PLACEHOLDER_TYPE.DELETED;
  } else if ([VIDEO_STATUS.ENCODING_IPFS, VIDEO_STATUS.IPFS_PINNING, VIDEO_STATUS.UPLOADED].includes(status)) {
    placeholderType = PLACEHOLDER_TYPE.PROCESSING;
  } else if (status === 'uploading' || status === 'processing' || status === 'finalizing') {
    placeholderType = PLACEHOLDER_TYPE.PROCESSING;
  } else if ([VIDEO_STATUS.ENCODING_FAILED, 'failed'].includes(status)) {
    placeholderType = PLACEHOLDER_TYPE.FAILED;
  }
  
  if (!placeholderType) {
    return { error: 'Video not ready', status: video.status };
  }
  
  const placeholderUrl = getPlaceholderVideo(placeholderType);
  if (!placeholderUrl) {
    return { error: 'Placeholder configuration error', status: video.status };
  }
  
  return {
    urls: createPlaceholderUrls(placeholderUrl),
    isPlaceholder: true
  };
}

// ============================================================================
// API ROUTES
// ============================================================================

/**
 * GET /api/watch?v=owner/permlink&info=true
 * or GET /api/watch?v=owner/permlink
 * Returns legacy video metadata from videos collection
 * When info=true: minimal JSON for mobile app (cid, thumbnail, views)
 * Without info: full response with fallback URLs for web player
 */
app.get('/api/watch', async (req, res) => {
  try {
    // Parse and validate parameters
    const params = parseVideoParams(req.query.v);
    if (params.error) {
      return res.status(400).json({ error: params.error });
    }
    
    const { owner, permlink } = params;
    const isInfoRequest = req.query.info === 'true';
    
    // Find video in legacy collection first, then fall back to embed collection
    const legacyVideo = await db.findLegacyVideo(owner, permlink);
    const embedVideo = !legacyVideo ? await db.findEmbedVideo(owner, permlink) : null;
    const video = legacyVideo || embedVideo;
    const isEmbed = !!embedVideo;

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Determine video URLs based on status and collection type
    const result = isEmbed
      ? getVideoUrlsForEmbedStatus(video)
      : getVideoUrlsForLegacyStatus(video);

    if (result.error) {
      return res.status(404).json({
        error: result.error,
        status: result.status
      });
    }

    // ===== MOBILE API RESPONSE (info=true) =====
    if (isInfoRequest) {
      const videoCdn = convertToCdnUrl(result.urls.primary);
      const thumbnailCdn = convertThumbnailToCdn(isEmbed ? video.thumbnail_url : video.thumbnail);

      const response = {
        cid: videoCdn,
        thumbnail: thumbnailCdn,
        views: video.views || 0
      };
      if (isEmbed) response.short = video.short || false;

      return res.json(response);
    }

    // ===== WEB PLAYER RESPONSE (full data with fallbacks) =====
    if (isEmbed) {
      const thumbnail = video.thumbnail_url
        || `${process.env.IPFS_GATEWAY}/${process.env.DEFAULT_THUMBNAIL_CID}`;

      res.json({
        success: true,
        type: 'embed',
        owner: video.owner,
        permlink: video.permlink,
        title: video.originalFilename || `${video.owner}/${video.permlink}`,
        status: video.status,
        isPlaceholder: result.isPlaceholder,
        videoUrl: proxiedManifest(result.urls.primary),
        // /hls races every gateway internally, so the player needs no separate fallback
        // chain. Equal fallbacks make the SDK drop them (it skips any === videoUrl) and
        // fire its fatal error promptly once the single /hls source is exhausted — that's
        // what drives the watch page's "no longer available" hint.
        videoUrlFallback1: proxiedManifest(result.urls.primary),
        videoUrlFallback2: proxiedManifest(result.urls.primary),
        videoUrlFallback3: proxiedManifest(result.urls.primary),
        thumbnail: thumbnail,
        duration: video.duration || 0,
        views: video.views || 0,
        short: video.short || false,
        createdAt: video.createdAt,
        updatedAt: video.updatedAt,
        encodingProgress: video.encodingProgress || 0
      });
    } else {
      res.json({
        success: true,
        type: 'legacy',
        owner: video.owner,
        permlink: video.permlink,
        title: video.title || 'Untitled Video',
        description: video.description || '',
        status: video.status,
        isPlaceholder: result.isPlaceholder,
        thumbnail: video.thumbnail
          ? transformIPFSUrl(video.thumbnail)
          : `${process.env.IPFS_GATEWAY}/${process.env.DEFAULT_THUMBNAIL_CID}`,
        videoUrl: proxiedManifest(result.urls.primary),
        // /hls races every gateway internally, so the player needs no separate fallback
        // chain. Equal fallbacks make the SDK drop them (it skips any === videoUrl) and
        // fire its fatal error promptly once the single /hls source is exhausted — that's
        // what drives the watch page's "no longer available" hint.
        videoUrlFallback1: proxiedManifest(result.urls.primary),
        videoUrlFallback2: proxiedManifest(result.urls.primary),
        videoUrlFallback3: proxiedManifest(result.urls.primary),
        duration: video.duration || 0,
        views: video.views || 0,
        tags: video.tags_v2 || video.tags || []
      });
    }
    
  } catch (error) {
    console.error('Error fetching legacy video:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/embed?v=owner/permlink&info=true
 * or GET /api/embed?v=owner/permlink
 * Returns embed video metadata from embed-video collection
 * When info=true: minimal JSON for mobile app (cid, thumbnail, short, views)
 * Without info: full response with fallback URLs for web player
 */
app.get('/api/embed', async (req, res) => {
  try {
    // Parse and validate parameters
    const params = parseVideoParams(req.query.v);
    if (params.error) {
      return res.status(400).json({ error: params.error });
    }
    
    const { owner, permlink } = params;
    const isInfoRequest = req.query.info === 'true';
    
    // Find video in embed collection
    const video = await db.findEmbedVideo(owner, permlink);
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Determine video URLs based on status
    const result = getVideoUrlsForEmbedStatus(video);
    
    if (result.error) {
      return res.status(404).json({ 
        error: result.error,
        status: result.status 
      });
    }
    
    // ===== MOBILE API RESPONSE (info=true) =====
    if (isInfoRequest) {
      const videoCdn = convertToCdnUrl(result.urls.primary);
      const thumbnailCdn = convertThumbnailToCdn(video.thumbnail_url);
      
      return res.json({
        cid: videoCdn,
        thumbnail: thumbnailCdn,
        short: video.short || false,
        views: video.views || 0
      });
    }
    
    // ===== WEB PLAYER RESPONSE (full data with fallbacks) =====
    const thumbnail = video.thumbnail_url
      || `${process.env.IPFS_GATEWAY}/${process.env.DEFAULT_THUMBNAIL_CID}`;

    // A finished video's player metadata is effectively immutable — the URLs are
    // content-addressed IPFS (Qm…/manifest.m3u8) and owner/permlink never change.
    // Let the browser serve repeats from cache so the player SDK + the view /
    // watch-duration resolvers don't each re-hit this per navigation or reload.
    // Placeholders / still-encoding videos DO change (status, progress) → no cache.
    const cacheable = !result.isPlaceholder
      && String(video.status || '').toLowerCase() === 'published';
    res.set('Cache-Control', cacheable ? 'public, max-age=300' : 'no-store');

    res.json({
      success: true,
      type: 'embed',
      owner: video.owner,
      permlink: video.permlink,
      title: video.originalFilename || `${video.owner}/${video.permlink}`,
      status: video.status,
      isPlaceholder: result.isPlaceholder,
      videoUrl: proxiedManifest(result.urls.primary),
      // /hls races every gateway internally, so equal fallbacks make the SDK drop its
      // separate chain and fire its fatal error promptly — see the /api/watch blocks.
      videoUrlFallback1: proxiedManifest(result.urls.primary),
      videoUrlFallback2: proxiedManifest(result.urls.primary),
      videoUrlFallback3: proxiedManifest(result.urls.primary),
      thumbnail: thumbnail,
      duration: video.duration || 0,
      views: video.views || 0,
      short: video.short || false,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
      encodingProgress: video.encodingProgress || 0
    });
    
  } catch (error) {
    console.error('Error fetching embed video:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/view
 * Increment view count only for published/ready videos (not placeholders)
 * Body: { owner, permlink, type: 'legacy' | 'embed' }
 */
app.post('/api/view', async (req, res) => {
  try {
    const { owner, permlink, type } = req.body;
    
    if (!owner || !permlink || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    let video = null;
    let success = false;
    
    // Fetch video to check status before incrementing views
    if (type === 'legacy') {
      video = await db.findLegacyVideo(owner, permlink);
    } else if (type === 'embed') {
      video = await db.findEmbedVideo(owner, permlink);
    } else {
      return res.status(400).json({ error: 'Invalid type. Must be "legacy" or "embed"' });
    }
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Check if video is in a "ready" status (not a placeholder)
    const status = video.status?.toLowerCase() || '';
    const isReadyStatus = [
      VIDEO_STATUS.PUBLISHED,
      VIDEO_STATUS.SCHEDULED,
      VIDEO_STATUS.PUBLISH_LATER,
      VIDEO_STATUS.PUBLISH_MANUAL
    ].includes(status);
    
    // Only increment views for ready/published videos, not placeholders
    if (isReadyStatus) {
      if (type === 'legacy') {
        success = await db.incrementLegacyViews(owner, permlink);
      } else {
        success = await db.incrementEmbedViews(owner, permlink);
        // Also log a per-event row (with viewer IP) so embed views can be
        // de-duplicated by IP later, matching the legacy `views` collection.
        const userIP = req.ip;
        const userAgent = req.headers['user-agent'] || '';
        try {
          await db.logEmbedView(owner, permlink, userIP, userAgent);
        } catch (logErr) {
          // Never fail the view request because the per-event log failed.
          console.error('Error logging embed view event:', logErr);
        }
      }
      res.json({ success: success, counted: true });
    } else {
      // Don't count views for placeholders (deleted/processing/failed)
      res.json({ success: false, counted: false, reason: 'Video not in published state' });
    }
    
  } catch (error) {
    console.error('Error incrementing views:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/duration
 * Self-healing: update video duration when the player detects it's missing or wrong
 * Body: { owner, permlink, duration }
 */
app.post('/api/duration', async (req, res) => {
  try {
    const { owner, permlink, duration } = req.body;
    const isValidId = (v) =>
      typeof v === 'string' &&
      v.trim().length > 0 &&
      /^[a-z0-9._-]+$/i.test(v);

    if (!isValidId(owner) || !isValidId(permlink) || !Number.isFinite(duration) || duration <= 0) {
      return res.status(400).json({ error: 'Missing or invalid fields' });
    }

    const success = await db.updateEmbedDuration(owner, permlink, Math.round(duration));
    res.json({ success });
  } catch (error) {
    console.error('Error updating duration:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Watch-duration heartbeat tracking (server-measured, anti-forge).
 * POST /api/watch/start → open a measured session
 * POST /api/watch/beat  → heartbeat; upserts one row in `view-durations`
 * Does NOT touch the `views` counter — that's POST /api/view.
 */
app.post('/api/watch/start', watchTracking.watchStart);
app.post('/api/watch/beat', watchTracking.watchBeat);
// GET /api/heatmap?v=owner/permlink — aggregate timeline-coverage buckets for a
// "most replayed" heatmap above the scrubber.
app.get('/api/heatmap', watchTracking.getHeatmap);

// Serve landing page for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'landing.html'));
});

// Serve the mobile debug helper page directly
app.get('/debug-mobile.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'debug-mobile.html'));
});

// Serve frontend for /watch, /embed and /play routes.
// /play is the "play without counting a view" entry point (playground): the
// client detects the /play path and skips the view increment, but still tracks
// watch duration. Use ?type=legacy for legacy videos (default: embed).
app.get(['/watch', '/embed', '/play'], (req, res) => {
  const videoParam = req.query.v;
  
  // If no video parameter, redirect to landing page
  if (!videoParam) {
    return res.redirect('/');
  }
  
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Serve static files from dist folder (after specific routes)
app.use(express.static(path.join(__dirname, 'dist')));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
async function startServer() {
  try {
    // Connect to MongoDB
    await db.connect();
    
    // Start Express server
    app.listen(PORT, () => {
      console.log(`✓ Server running on http://localhost:${PORT}`);
      console.log(`  - Legacy videos: http://localhost:${PORT}/watch?v=owner/permlink`);
      console.log(`  - Embed videos: http://localhost:${PORT}/embed?v=owner/permlink`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await db.close();
  process.exit(0);
});

// Start the server
startServer();
