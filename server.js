const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
require('dotenv').config();

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3005;

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
    cdn: 'https://ipfs-3speak.b-cdn.net/ipfs',         // BunnyCDN IPFS (primary - legacy pullzone)
    hotcdn: 'https://hotipfs-3speak-1.b-cdn.net/hls',   // BunnyCDN Hotnode (fallback)
    supernode: 'https://ipfs.3speak.tv/ipfs',          // Supernode (direct IPFS)
    audionode: 'https://ipfs-audio.3speak.tv/ipfs'     // Audionode (backup)
  };
  
  if (ipfsUrl.startsWith('ipfs://')) {
    const cidPath = ipfsUrl.replace('ipfs://', '');
    return {
      primary: `${gateways.cdn}/${cidPath}`,
      fallback1: `${gateways.hotcdn}/${cidPath}`,
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
 * GET /api/watch?v=owner/permlink
 * Returns legacy video metadata from videos collection
 */
app.get('/api/watch', async (req, res) => {
  try {
    // Parse and validate parameters
    const params = parseVideoParams(req.query.v);
    if (params.error) {
      return res.status(400).json({ error: params.error });
    }
    
    const { owner, permlink } = params;
    
    // Find video in legacy collection
    const video = await db.findLegacyVideo(owner, permlink);
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Determine video URLs based on status
    const result = getVideoUrlsForLegacyStatus(video);
    
    if (result.error) {
      return res.status(404).json({ 
        error: result.error,
        status: result.status 
      });
    }
    
    // Return video data with CDN-first fallback chain
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
    
  } catch (error) {
    console.error('Error fetching legacy video:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/embed?v=owner/permlink
 * Returns embed video metadata from embed-video collection
 */
app.get('/api/embed', async (req, res) => {
  try {
    // Parse and validate parameters
    const params = parseVideoParams(req.query.v);
    if (params.error) {
      return res.status(400).json({ error: params.error });
    }
    
    const { owner, permlink } = params;
    
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
    
    // Determine thumbnail
    const thumbnail = video.thumbnail_url 
      || `${process.env.IPFS_GATEWAY}/${process.env.DEFAULT_THUMBNAIL_CID}`;
    
    // Return video data with CDN-first fallback chain
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

// Serve landing page for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'landing.html'));
});

// Serve the mobile debug helper page directly
app.get('/debug-mobile.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'debug-mobile.html'));
});

// Serve frontend for /watch and /embed routes
app.get(['/watch', '/embed'], (req, res) => {
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
