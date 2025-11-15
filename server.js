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

// Serve static files from dist folder
app.use(express.static(path.join(__dirname, 'dist')));

// Helper: Transform IPFS URL to gateway URL with fallback
function transformIPFSUrl(ipfsUrl, useFallback = false) {
  const gateway = useFallback ? process.env.IPFS_GATEWAY_FALLBACK : process.env.IPFS_GATEWAY;
  
  if (ipfsUrl.startsWith('ipfs://')) {
    // Remove ipfs:// prefix and construct gateway URL
    const cidPath = ipfsUrl.replace('ipfs://', '');
    return `${gateway}/${cidPath}`;
  }
  
  return ipfsUrl;
}

// Helper: Get both gateway URLs for a video
function getVideoUrls(ipfsUrl) {
  return {
    primary: transformIPFSUrl(ipfsUrl, false),
    fallback: transformIPFSUrl(ipfsUrl, true)
  };
}

// Helper: Get placeholder video URL based on status
function getPlaceholderVideo(status) {
  const gateway = process.env.IPFS_GATEWAY;
  
  switch (status?.toLowerCase()) {
    case 'uploading':
    case 'encoding':
      return transformIPFSUrl(process.env.PLACEHOLDER_PROCESSING_CID);
    
    case 'finalizing':
      return transformIPFSUrl(process.env.PLACEHOLDER_FINALIZING_CID);
    
    case 'failed':
      return transformIPFSUrl(process.env.PLACEHOLDER_FAILED_CID);
    
    case 'deleted':
      return transformIPFSUrl(process.env.PLACEHOLDER_DELETED_CID);
    
    default:
      return null;
  }
}

// API Routes

/**
 * GET /api/watch?v=owner/permlink
 * Returns legacy video metadata
 */
app.get('/api/watch', async (req, res) => {
  try {
    const videoParam = req.query.v;
    
    if (!videoParam) {
      return res.status(400).json({ error: 'Missing video parameter (v)' });
    }
    
    // Parse owner/permlink
    const [owner, permlink] = videoParam.split('/');
    
    if (!owner || !permlink) {
      return res.status(400).json({ error: 'Invalid video format. Expected: owner/permlink' });
    }
    
    // Find video in legacy collection
    const video = await db.findLegacyVideo(owner, permlink);
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Check if video has video_v2 field
    if (!video.video_v2) {
      return res.status(404).json({ error: 'Video source not available' });
    }
    
    // Transform IPFS URL with fallback
    const videoUrls = getVideoUrls(video.video_v2);
    
    // Return video data
    res.json({
      success: true,
      type: 'legacy',
      owner: video.owner,
      permlink: video.permlink,
      title: video.title || 'Untitled Video',
      description: video.description || '',
      thumbnail: video.thumbnail ? transformIPFSUrl(video.thumbnail, true) : null, // Use fallback gateway for thumbnails
      videoUrl: videoUrls.primary,
      videoUrlFallback: videoUrls.fallback,
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
 * Returns embed video metadata with placeholder logic
 */
app.get('/api/embed', async (req, res) => {
  try {
    const videoParam = req.query.v;
    
    if (!videoParam) {
      return res.status(400).json({ error: 'Missing video parameter (v)' });
    }
    
    // Parse owner/permlink
    const [owner, permlink] = videoParam.split('/');
    
    if (!owner || !permlink) {
      return res.status(400).json({ error: 'Invalid video format. Expected: owner/permlink' });
    }
    
    // Find video in embed collection
    const video = await db.findEmbedVideo(owner, permlink);
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    let videoUrls;
    let isPlaceholder = false;
    
    // Check status and determine which video to serve
    if (video.status === 'published' && video.manifest_cid) {
      // Serve actual video with fallback
      const gateway = process.env.IPFS_GATEWAY;
      const gatewayFallback = process.env.IPFS_GATEWAY_FALLBACK;
      videoUrls = {
        primary: `${gateway}/${video.manifest_cid}/manifest.m3u8`,
        fallback: `${gatewayFallback}/${video.manifest_cid}/manifest.m3u8`
      };
    } else {
      // Serve placeholder based on status
      const placeholderUrl = getPlaceholderVideo(video.status);
      isPlaceholder = true;
      
      if (!placeholderUrl) {
        return res.status(400).json({ 
          error: 'Video not ready',
          status: video.status 
        });
      }
      
      videoUrls = { primary: placeholderUrl, fallback: placeholderUrl };
    }
    
    // Return video data
    res.json({
      success: true,
      type: 'embed',
      owner: video.owner,
      permlink: video.permlink,
      status: video.status,
      isPlaceholder: isPlaceholder,
      videoUrl: videoUrls.primary,
      videoUrlFallback: videoUrls.fallback,
      thumbnailUrl: video.thumbnail_url || null,
      duration: video.duration || 0,
      views: video.views || 0,
      createdAt: video.createdAt,
      encodingProgress: video.encodingProgress || 0
    });
    
  } catch (error) {
    console.error('Error fetching embed video:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/view
 * Increment view count
 * Body: { owner, permlink, type: 'legacy' | 'embed' }
 */
app.post('/api/view', async (req, res) => {
  try {
    const { owner, permlink, type } = req.body;
    
    if (!owner || !permlink || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    let success = false;
    
    if (type === 'legacy') {
      success = await db.incrementLegacyViews(owner, permlink);
    } else if (type === 'embed') {
      success = await db.incrementEmbedViews(owner, permlink);
    } else {
      return res.status(400).json({ error: 'Invalid type. Must be "legacy" or "embed"' });
    }
    
    res.json({ success: success });
    
  } catch (error) {
    console.error('Error incrementing views:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve frontend for /watch and /embed routes
app.get(['/watch', '/embed'], (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

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
