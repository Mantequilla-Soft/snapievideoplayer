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
        videoUrl: result.urls.primary,
        videoUrlFallback1: result.urls.fallback1,
        videoUrlFallback2: result.urls.fallback2,
        videoUrlFallback3: result.urls.fallback3,
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
        videoUrl: result.urls.primary,
        videoUrlFallback1: result.urls.fallback1,
        videoUrlFallback2: result.urls.fallback2,
        videoUrlFallback3: result.urls.fallback3,
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
    
    res.json({
      success: true,
      type: 'embed',
      owner: video.owner,
      permlink: video.permlink,
      title: video.originalFilename || `${video.owner}/${video.permlink}`,
      status: video.status,
      isPlaceholder: result.isPlaceholder,
      videoUrl: result.urls.primary,
      videoUrlFallback1: result.urls.fallback1,
      videoUrlFallback2: result.urls.fallback2,
      videoUrlFallback3: result.urls.fallback3,
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
